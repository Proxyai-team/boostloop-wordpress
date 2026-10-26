<?php
/**
 * The BoostLoop screen in wp-admin. All UI is BoostLoop's own React app, shipped in admin/dist (built from the
 * site's screens, see admin-build/); PHP only pairs the site and prints the mount point.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'admin_menu',
	function () {
		$hook = add_menu_page( __( 'BoostLoop', 'boostloop-aeo' ), __( 'BoostLoop', 'boostloop-aeo' ), 'manage_options', 'boostloop', 'boostloop_aeo_page', 'dashicons-chart-line', 81 );
		add_action(
			'admin_enqueue_scripts',
			function ( $current ) use ( $hook ) {
				if ( $current !== $hook ) {
					return;
				}
				$dist = plugins_url( 'admin/dist/', BOOSTLOOP_AEO_FILE );
				wp_enqueue_style( 'boostloop-admin', $dist . 'boostloop-admin.css', array(), BOOSTLOOP_AEO_VERSION );
				wp_enqueue_script( 'boostloop-admin', $dist . 'boostloop-admin.js', array(), BOOSTLOOP_AEO_VERSION, true );
				wp_localize_script(
					'boostloop-admin',
					'BoostLoopWP',
					array(
						'restUrl'   => esc_url_raw( rest_url() ),
						'nonce'     => wp_create_nonce( 'wp_rest' ),
						'ajaxUrl'   => admin_url( 'admin-ajax.php' ),
						'assetsUrl' => $dist . 'public/',
						'appUrl'    => BOOSTLOOP_AEO_APP,
						'pageUrl'   => admin_url( 'admin.php?page=boostloop' ),
					)
				);
			}
		);
	}
);

add_filter(
	'plugin_action_links_' . plugin_basename( BOOSTLOOP_AEO_FILE ),
	function ( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'admin.php?page=boostloop' ) ) . '">' . esc_html__( 'Open BoostLoop', 'boostloop-aeo' ) . '</a>' );
		return $links;
	}
);

add_action(
	'admin_post_boostloop_aeo_reset',
	function () {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'boostloop-aeo' ), 403 );
		}
		check_admin_referer( 'boostloop_aeo_reset' );
		boostloop_aeo_restore_physical();
		delete_option( 'boostloop_aeo_artifacts' );
		delete_option( 'boostloop_aeo_section' );
		delete_option( 'boostloop_aeo_commerce' );
		boostloop_aeo_restore_options();
		wp_safe_redirect( admin_url( 'admin.php?page=boostloop' ) );
		exit;
	}
);

function boostloop_aeo_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$connected = get_option( 'boostloop_aeo_secret' ) ? true : boostloop_aeo_connect();
	if ( is_wp_error( $connected ) ) {
		/* translators: %s: error message from the connection attempt. */
		echo '<div class="wrap"><h1>BoostLoop</h1><div class="notice notice-error"><p>' . esc_html( sprintf( __( 'Could not connect this site to BoostLoop: %s', 'boostloop-aeo' ), $connected->get_error_message() ) ) . '</p></div></div>';
		return;
	}
	echo '<div id="boostloop-app" style="margin-left:-20px"></div>';
	echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="padding:8px 0">';
	echo '<input type="hidden" name="action" value="boostloop_aeo_reset">';
	wp_nonce_field( 'boostloop_aeo_reset' );
	submit_button( __( 'Remove all BoostLoop fixes from this site', 'boostloop-aeo' ), 'link', 'submit', false );
	echo '</form>';
}
