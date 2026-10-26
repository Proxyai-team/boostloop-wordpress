<?php
/**
 * Pairing and the REST proxy. The site secret is generated here, kept in this site's options, and only ever sent
 * server to server. The admin screen's browser code calls this site's own REST API; nothing it holds can reach
 * BoostLoop directly.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Endpoints the plugin screen may reach; BoostLoop enforces the same list for site-authenticated calls. */
const BOOSTLOOP_AEO_PATHS = '#^(me|wallet|karma/checkout|campaigns(/.*)?|contributions(/.*)?|proofs/review|proof-files/[\w-]+|hall-of-fame|aeo/(scan|fix|leaderboard|domain/[^/]+)|mcp-tokens(/.*)?)$#';

function boostloop_aeo_can_manage() {
	return current_user_can( 'manage_options' );
}

add_action(
	'rest_api_init',
	function () {
		// BoostLoop's ownership check during connect: only the install holding the pending secret can sign the nonce.
		register_rest_route(
			'boostloop/v1',
			'/confirm',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function ( WP_REST_Request $request ) {
					$secret = get_transient( 'boostloop_aeo_pending_secret' );
					$nonce  = (string) $request->get_param( 'nonce' );
					if ( ! $secret || ! preg_match( '/^[a-f0-9]{64}$/', $nonce ) ) {
						return new WP_Error( 'boostloop_not_pairing', 'Not pairing', array( 'status' => 404 ) );
					}
					return array( 'signature' => hash_hmac( 'sha256', $nonce, $secret ) );
				},
			)
		);
		// The site owner's approval of the drafted homepage text: publish it, or take it down.
		// The fix's suggested meta description rides with the section and goes live only here on approval, so
		// approving the text alone also gives the homepage a description.
		register_rest_route(
			'boostloop/v1',
			'/section',
			array(
				'methods'             => array( 'POST', 'DELETE' ),
				'permission_callback' => 'boostloop_aeo_can_manage',
				'callback'            => function ( WP_REST_Request $request ) {
					if ( 'DELETE' === $request->get_method() ) {
						delete_option( 'boostloop_aeo_section' );
						boostloop_aeo_remove_head_description();
						return array( 'published' => false );
					}
					$params = $request->get_json_params();
					$text   = sanitize_textarea_field( is_array( $params ) && isset( $params['text'] ) ? (string) $params['text'] : '' );
					if ( '' === trim( $text ) || strlen( $text ) > 4000 ) {
						return new WP_Error( 'boostloop_section', 'Text is required (max 4000 characters)', array( 'status' => 400 ) );
					}
					$description = is_array( $params ) && isset( $params['description'] ) ? sanitize_text_field( (string) $params['description'] ) : '';
					if ( mb_strlen( $description ) > 200 ) {
						$description = mb_substr( $description, 0, 197 ) . '...';
					}
					update_option(
						'boostloop_aeo_section',
						array(
							'title'       => 'What we do',
							'text'        => $text,
							'description' => $description,
						),
						false
					);
					boostloop_aeo_publish_head_description( $description );
					return array(
						'published'   => true,
						'description' => '' !== $description,
					);
				},
			)
		);
		register_rest_route(
			'boostloop/v1',
			'/api/(?P<path>.+)',
			array(
				'methods'             => array( 'GET', 'POST', 'PATCH', 'DELETE' ),
				'permission_callback' => 'boostloop_aeo_can_manage',
				'callback'            => 'boostloop_aeo_proxy',
			)
		);
	}
);

/** Pairs this site with BoostLoop: one account per site, the same one again after a reinstall. */
function boostloop_aeo_connect() {
	$secret = bin2hex( random_bytes( 32 ) );
	set_transient( 'boostloop_aeo_pending_secret', $secret, 120 );
	$res = wp_remote_post(
		BOOSTLOOP_AEO_APP . '/api/embed/connect',
		array(
			'timeout' => 30,
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode(
				array(
					'site_url' => home_url( '/' ),
					'secret'   => $secret,
					'email'    => get_option( 'admin_email' ),
					'name'     => get_bloginfo( 'name' ),
					'platform' => 'wordpress',
				)
			),
		)
	);
	delete_transient( 'boostloop_aeo_pending_secret' );
	if ( is_wp_error( $res ) ) {
		return $res;
	}
	if ( wp_remote_retrieve_response_code( $res ) !== 201 ) {
		$body = json_decode( wp_remote_retrieve_body( $res ), true );
		return new WP_Error( 'boostloop_connect', is_array( $body ) && isset( $body['error'] ) ? $body['error'] : 'HTTP ' . wp_remote_retrieve_response_code( $res ) );
	}
	update_option( 'boostloop_aeo_secret', $secret, false );
	return true;
}

/** Forwards one allowlisted call to BoostLoop as this site. Auto-fix responses carry the files this site then serves. */
function boostloop_aeo_proxy( WP_REST_Request $request ) {
	$path   = (string) $request['path'];
	$secret = get_option( 'boostloop_aeo_secret' );
	if ( ! preg_match( BOOSTLOOP_AEO_PATHS, $path ) ) {
		return new WP_Error( 'boostloop_forbidden', 'Not available in the plugin', array( 'status' => 403 ) );
	}
	if ( ! $secret ) {
		return new WP_Error( 'boostloop_not_connected', 'This site is not connected to BoostLoop', array( 'status' => 409 ) );
	}
	$query = $request->get_query_params();
	unset( $query['path'], $query['rest_route'], $query['_wpnonce'], $query['_locale'] );
	$url   = BOOSTLOOP_AEO_APP . '/api/' . $path . ( $query ? '?' . http_build_query( $query, '', '&', PHP_QUERY_RFC3986 ) : '' );
	$args  = array(
		'method'  => $request->get_method(),
		'timeout' => 'aeo/fix' === $path || 'aeo/scan' === $path ? 120 : 30,
		'headers' => array( 'X-BoostLoop-Site' => $secret ),
	);
	$files = $request->get_file_params();
	if ( $files ) {
		// Proof screenshots: PHP already parsed the upload, so rebuild the multipart body.
		$boundary                        = 'boostloop' . wp_generate_password( 24, false );
		$args['headers']['Content-Type'] = 'multipart/form-data; boundary=' . $boundary;
		$args['body']                    = boostloop_aeo_multipart( $request->get_body_params(), $files, $boundary );
	} elseif ( '' !== $request->get_body() ) {
		$args['headers']['Content-Type'] = 'application/json';
		$args['body']                    = $request->get_body();
		if ( 'aeo/fix' === $path ) {
			// The store's own currency, for product pages that show an amount without saying which currency it is.
			$fix      = json_decode( $args['body'], true );
			$currency = strtoupper( (string) get_option( 'woocommerce_currency', '' ) );
			if ( is_array( $fix ) ) {
				$extra = preg_match( '/^[A-Z]{3}$/', $currency ) ? array( 'currency' => $currency ) : array();
				if ( in_array( (int) ( $fix['check_id'] ?? 0 ), array( 13, 27, 29 ), true ) ) {
					$extra['products'] = boostloop_aeo_catalogue( $currency );
				}
				$args['body'] = wp_json_encode( $extra + $fix );
			}
		}
	}
	if ( $args['timeout'] > 30 && function_exists( 'set_time_limit' ) ) {
		@set_time_limit( $args['timeout'] + 15 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, Squiz.PHP.DiscouragedFunctions.Discouraged -- scans and first fixes crawl the site.
	}
	$res = wp_remote_request( $url, $args );
	if ( is_wp_error( $res ) ) {
		return new WP_Error( 'boostloop_unreachable', $res->get_error_message(), array( 'status' => 502 ) );
	}
	$status = (int) wp_remote_retrieve_response_code( $res );
	$type   = (string) wp_remote_retrieve_header( $res, 'content-type' );
	$body   = wp_remote_retrieve_body( $res );
	if ( false === strpos( $type, 'json' ) ) {
		// Proof screenshots stream back as-is.
		status_header( $status );
		header( 'Content-Type: ' . $type );
		header( 'Cache-Control: private, no-store' );
		header( 'X-Content-Type-Options: nosniff' );
		echo $body; // phpcs:ignore WordPress.Security.EscapeOutput -- binary file from BoostLoop, served with its own type and nosniff.
		exit;
	}
	$data = json_decode( $body, true );
	if ( 'aeo/fix' === $path && 200 === $status && isset( $data['artifacts'], $data['check_id'] ) ) {
		boostloop_aeo_store_artifacts( (int) $data['check_id'], $data['artifacts'] );
		boostloop_aeo_apply_options( $data['artifacts'] );
		$data['stale']     = boostloop_aeo_stale_files( $data['artifacts'] );
		$data['drafts']    = boostloop_aeo_store_drafts( $data['artifacts'] );
		$data['artifacts'] = count( $data['artifacts'] );
	}
	return new WP_REST_Response( $data, $status );
}

/**
 * The homepage description meta, stored as the homepage `head` artifact so the wp_head hook prints it. Merges with
 * (never clobbers) whatever the metadata fix already stored: the description line is replaced, other tags stay.
 */
function boostloop_aeo_publish_head_description( $description ) {
	$stored = get_option( 'boostloop_aeo_artifacts', array() );
	$stored = is_array( $stored ) ? $stored : array();
	$key    = 'head|/|text/html';
	$rest   = '';
	if ( isset( $stored[ $key ]['content'] ) ) {
		$rest = (string) $stored[ $key ]['content'];
		$rest = preg_replace( '/<meta\s+name="description"[^>]*>\s*/i', '', $rest );
		$rest = trim( (string) $rest );
	}
	if ( '' === trim( $description ) ) {
		if ( '' === $rest ) {
			unset( $stored[ $key ] );
		} else {
			$stored[ $key ]['content'] = $rest;
		}
	} else {
		$tag            = '<meta name="description" content="' . esc_attr( $description ) . '">';
		$stored[ $key ] = array(
			'placement' => 'head',
			'path'      => '/',
			'type'      => 'text/html',
			'content'   => trim( $tag . "\n" . $rest ),
			'check'     => 14,
		);
	}
	update_option( 'boostloop_aeo_artifacts', $stored, false );
}

/** Removes the homepage description meta line; other stored head tags stay. */
function boostloop_aeo_remove_head_description() {
	$stored = get_option( 'boostloop_aeo_artifacts', array() );
	if ( ! is_array( $stored ) || ! isset( $stored['head|/|text/html']['content'] ) ) {
		return;
	}
	$rest = trim( (string) preg_replace( '/<meta\s+name="description"[^>]*>\s*/i', '', (string) $stored['head|/|text/html']['content'] ) );
	if ( '' === $rest ) {
		unset( $stored['head|/|text/html'] );
	} else {
		$stored['head|/|text/html']['content'] = $rest;
	}
	update_option( 'boostloop_aeo_artifacts', $stored, false );
}

/**
 * Files (robots.txt, llms.txt, .md) as the public sees them: a plain request to this site, through whatever CDN is in
 * front of it. A path whose live body differs from what we just stored is held by a cache; the fix is saved and
 * shows once the cache expires or is purged. Unreachable or redirected checks say nothing.
 */
function boostloop_aeo_stale_files( array $artifacts ) {
	$stale = array();
	foreach ( $artifacts as $a ) {
		if ( ! isset( $a['placement'], $a['path'], $a['content'] ) || 'file' !== $a['placement'] ) {
			continue;
		}
		$path = boostloop_aeo_norm_path( $a['path'] );
		if ( ! boostloop_aeo_write_physical( $path, (string) $a['content'] ) ) {
			// A real file the web server serves before WordPress, and we could not write it: the fix cannot show.
			$stale[] = array(
				'path'     => $path,
				'cache'    => '',
				'physical' => true,
			);
			continue;
		}
		$res = wp_remote_get(
			home_url( $path ),
			array(
				'timeout'     => 10,
				'redirection' => 0,
				'user-agent'  => 'BoostLoop-Plugin/' . BOOSTLOOP_AEO_VERSION,
			)
		);
		if ( is_wp_error( $res ) ) {
			continue;
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( $code >= 300 && $code < 400 ) {
			continue;
		}
		if ( 200 !== $code || trim( wp_remote_retrieve_body( $res ) ) !== trim( (string) $a['content'] ) ) {
			$stale[] = array(
				'path'  => boostloop_aeo_norm_path( $a['path'] ),
				'cache' => (string) wp_remote_retrieve_header( $res, 'cf-cache-status' ),
			);
		}
	}
	return $stale;
}

/**
 * A real robots.txt / llms.txt / .md file in the site root is served before WordPress runs, so the stored fix would
 * never show. The fix content is built from what the site serves (its own rules included), so it replaces the file;
 * the original is kept once as `<file>.boostloop-bak` and put back by "Remove all fixes".
 * Returns true when there is no such file or it was updated, false when it exists but cannot be written.
 */
function boostloop_aeo_write_physical( $path, $content ) {
	$file = untrailingslashit( ABSPATH ) . $path; // phpcs:ignore PluginCheck.CodeAnalysis.WriteFile.ABSPATHDetected -- the site-root robots.txt/llms.txt must be replaced where it is served from.
	if ( ! is_file( $file ) ) {
		return true;
	}
	$backup = $file . '.boostloop-bak';
	if ( ! file_exists( $backup ) && ! @copy( $file, $backup ) ) { // phpcs:ignore PluginCheck.CodeAnalysis.WriteFile.ABSPATHDetected, WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions -- keep the original once.
		return false;
	}
	if ( ! is_writable( $file ) || false === file_put_contents( $file, $content, LOCK_EX ) ) { // phpcs:ignore PluginCheck.CodeAnalysis.WriteFile.ABSPATHDetected, WordPress.WP.AlternativeFunctions -- root files are not under WP_Filesystem's content dir.
		return false;
	}
	$written          = get_option( 'boostloop_aeo_written', array() );
	$written          = is_array( $written ) ? $written : array();
	$written[ $path ] = true;
	update_option( 'boostloop_aeo_written', $written, false );
	return true;
}

/** Puts back every physical file the plugin replaced. */
function boostloop_aeo_restore_physical() {
	$written = get_option( 'boostloop_aeo_written', array() );
	foreach ( is_array( $written ) ? array_keys( $written ) : array() as $path ) {
		$file   = untrailingslashit( ABSPATH ) . $path; // phpcs:ignore PluginCheck.CodeAnalysis.WriteFile.ABSPATHDetected -- restoring the original site-root file.
		$backup = $file . '.boostloop-bak';
		if ( is_file( $backup ) ) {
			@rename( $backup, $file ); // phpcs:ignore PluginCheck.CodeAnalysis.WriteFile.ABSPATHDetected, WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions
		}
	}
	delete_option( 'boostloop_aeo_written' );
}

/** WooCommerce's published catalogue (name, link, price, image) for the price and product-feed fixes. Empty without WooCommerce. */
function boostloop_aeo_catalogue( $currency ) {
	if ( ! function_exists( 'wc_get_products' ) ) {
		return array();
	}
	$out = array();
	try {
		foreach ( wc_get_products(
			array(
				'status'  => 'publish',
				'limit'   => 200,
				'orderby' => 'date',
				'order'   => 'DESC',
			)
		) as $product ) {
			// Not is_visible(): its filters expect a storefront request and can fatal inside a REST call.
			if ( 'hidden' === $product->get_catalog_visibility() || '' === (string) $product->get_price() ) {
				continue;
			}
			$image = wp_get_attachment_url( $product->get_image_id() );
			$out[] = array(
				'name'     => $product->get_name(),
				'url'      => get_permalink( $product->get_id() ),
				'price'    => (string) $product->get_price(),
				'currency' => (string) $currency,
				'image'    => $image ? $image : '',
			);
		}
	} catch ( Throwable $e ) {
		return array(); // never let a catalogue problem stop a fix; the crawl is the fallback.
	}
	return $out;
}

function boostloop_aeo_multipart( array $fields, array $files, $boundary ) {
	$out = '';
	foreach ( $fields as $name => $value ) {
		$out .= "--$boundary\r\nContent-Disposition: form-data; name=\"" . str_replace( '"', '', $name ) . "\"\r\n\r\n" . $value . "\r\n";
	}
	foreach ( $files as $name => $file ) {
		$names = (array) $file['name'];
		$types = (array) $file['type'];
		foreach ( (array) $file['tmp_name'] as $i => $tmp ) {
			if ( ! is_uploaded_file( $tmp ) ) {
				continue;
			}
			$filename = str_replace( '"', '', (string) $names[ $i ] );
			$mime     = (string) $types[ $i ];
			$out     .= "--$boundary\r\nContent-Disposition: form-data; name=\"" . str_replace( '"', '', $name ) . "\"; filename=\"$filename\"\r\nContent-Type: $mime\r\n\r\n" . file_get_contents( $tmp ) . "\r\n"; // phpcs:ignore WordPress.WP.AlternativeFunctions -- reading PHP's own upload temp file.
		}
	}
	return $out . "--$boundary--\r\n";
}
