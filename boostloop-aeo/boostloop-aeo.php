<?php
/**
 * Plugin Name: BoostLoop
 * Description: BoostLoop in wp-admin: scan this site for AI-agent readiness, auto-fix it (robots.txt, JSON-LD, metadata, llms.txt, markdown pages), top up karma, run campaigns and connect MCP.
 * Version: 0.3.14
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * License: GPLv2 or later
 * Text Domain: boostloop-aeo
 */

if (!defined('ABSPATH')) {
	exit;
}

define('BOOSTLOOP_AEO_FILE', __FILE__);
define('BOOSTLOOP_AEO_VERSION', '0.3.14');
if (!defined('BOOSTLOOP_AEO_APP')) {
	define('BOOSTLOOP_AEO_APP', 'https://boostloop.club'); // override in wp-config.php for staging
}

require_once __DIR__ . '/includes/api.php';
require_once __DIR__ . '/includes/admin.php';
require_once __DIR__ . '/includes/commerce.php';

/** Request path without trailing slash; the homepage is '/'. Fix artifacts are keyed the same way. */
function boostloop_aeo_norm_path($path) {
	return '/' . trim((string) $path, '/');
}

function boostloop_aeo_current_path() {
	$uri = isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '/';
	return boostloop_aeo_norm_path((string) wp_parse_url($uri, PHP_URL_PATH));
}

/** Stored artifacts, keyed "placement|path|contentType" so checks that share an artifact (1-3, 8/9) replace it. */
function boostloop_aeo_artifacts() {
	$stored = get_option('boostloop_aeo_artifacts', []);
	return is_array($stored) ? $stored : [];
}

function boostloop_aeo_store_artifacts($check_id, array $artifacts) {
	$stored = boostloop_aeo_artifacts();
	foreach ($artifacts as $a) {
		if (!isset($a['placement'], $a['path'], $a['contentType'], $a['content']) || !in_array($a['placement'], ['file', 'head', 'header'], true)) {
			continue; // drafts (page, section) wait for approval, options and forms are handled elsewhere.
		}
		$path = boostloop_aeo_norm_path($a['path']);
		$stored[$a['placement'] . '|' . $path . '|' . $a['contentType']] = [
			'placement' => $a['placement'],
			'path' => $path,
			'type' => $a['contentType'],
			'content' => (string) $a['content'],
			'check' => (int) $check_id,
		];
	}
	update_option('boostloop_aeo_artifacts', $stored, false);
}

/** Site settings a fix may change, with the value to restore on "Remove all fixes". */
const BOOSTLOOP_AEO_OPTIONS = ['blog_public', 'boostloop_aeo_hard404'];

function boostloop_aeo_apply_options(array $artifacts) {
	$prior = get_option('boostloop_aeo_options_prior', []);
	$prior = is_array($prior) ? $prior : [];
	foreach ($artifacts as $a) {
		if (!isset($a['placement'], $a['path'], $a['content']) || 'option' !== $a['placement'] || !in_array($a['path'], BOOSTLOOP_AEO_OPTIONS, true)) {
			continue;
		}
		if (!array_key_exists($a['path'], $prior)) {
			$prior[$a['path']] = get_option($a['path'], null);
		}
		update_option($a['path'], '1' === (string) $a['content'] ? '1' : '0');
	}
	update_option('boostloop_aeo_options_prior', $prior, false);
}

function boostloop_aeo_restore_options() {
	$prior = get_option('boostloop_aeo_options_prior', []);
	foreach (is_array($prior) ? $prior : [] as $name => $value) {
		if (in_array($name, BOOSTLOOP_AEO_OPTIONS, true)) {
			null === $value ? delete_option($name) : update_option($name, $value);
		}
	}
	delete_option('boostloop_aeo_options_prior');
}

/** Plain text from BoostLoop to safe paragraph HTML. */
function boostloop_aeo_paragraphs($text) {
	return wpautop(esc_html(trim((string) $text)));
}

/**
 * Drafts from checks 12 and 14. Trust pages become unpublished WordPress pages (one per kind, updated in place while
 * still a draft); the homepage text waits for approval in the plugin screen. Nothing goes public from here.
 */
function boostloop_aeo_store_drafts(array $artifacts) {
	$drafts = [];
	foreach ($artifacts as $a) {
		if (!isset($a['placement'], $a['path'], $a['content'])) {
			continue;
		}
		$text = sanitize_textarea_field((string) $a['content']);
		$title = sanitize_text_field(isset($a['title']) ? (string) $a['title'] : '');
		if ('section' === $a['placement']) {
			$description = sanitize_text_field(isset($a['description']) ? (string) $a['description'] : '');
			$drafts[] = ['kind' => 'section', 'title' => $title, 'text' => $text, 'description' => $description];
		} elseif ('page' === $a['placement'] && '' !== $title) {
			$kind = sanitize_key(trim((string) $a['path'], '/'));
			$found = get_posts(['post_type' => 'page', 'post_status' => 'any', 'meta_key' => '_boostloop_aeo_draft', 'meta_value' => $kind, 'numberposts' => 1, 'fields' => 'ids']); // phpcs:ignore WordPress.DB.SlowDBQuery -- one lookup per draft page.
			$post = ['post_type' => 'page', 'post_status' => 'draft', 'post_title' => $title, 'post_content' => boostloop_aeo_paragraphs($text)];
			if ($found) {
				$id = (int) $found[0];
				if ('draft' === get_post_status($id)) {
					wp_update_post(['ID' => $id] + $post);
				}
			} else {
				$id = (int) wp_insert_post($post);
				if ($id) {
					update_post_meta($id, '_boostloop_aeo_draft', $kind);
				}
			}
			if ($id) {
				$drafts[] = ['kind' => 'page', 'title' => $title, 'edit' => get_edit_post_link($id, 'raw'), 'status' => get_post_status($id)];
			}
		}
	}
	return $drafts;
}

/** The approved "what we do" text, shown on the homepage (visible text is what agents read). */
add_action('wp_footer', function () {
	$section = get_option('boostloop_aeo_section');
	if (!is_front_page() || !is_array($section) || empty($section['text'])) {
		return;
	}
	echo '<section class="boostloop-about" aria-label="' . esc_attr(isset($section['title']) ? $section['title'] : 'About') . '">' . wp_kses_post(boostloop_aeo_paragraphs($section['text'])) . "</section>\n";
}, 5);

function boostloop_aeo_find($placement, $path, $type_prefix) {
	foreach (boostloop_aeo_artifacts() as $a) {
		if ($a['placement'] === $placement && $a['path'] === $path && strpos($a['type'], $type_prefix) === 0) {
			return $a;
		}
	}
	return null;
}

/** Checks 1-3: replaces WordPress's virtual robots.txt. A physical robots.txt file bypasses this filter. */
add_filter('robots_txt', function ($output, $public) {
	if (!$public) {
		return $output; // "Discourage search engines" is on; respect it.
	}
	$a = boostloop_aeo_find('file', '/robots.txt', 'text/plain');
	return $a ? $a['content'] : $output;
}, 100, 2);

/** Checks 8, 9, 10: JSON-LD and meta/link tags for the current page. */
add_action('wp_head', function () {
	$path = boostloop_aeo_current_path();
	foreach (boostloop_aeo_artifacts() as $a) {
		if ($a['placement'] !== 'head' || $a['path'] !== $path) {
			continue;
		}
		if ($a['type'] === 'application/ld+json') {
			$data = json_decode($a['content'], true);
			if (is_array($data)) {
				echo '<script type="application/ld+json">' . wp_json_encode($data, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP) . "</script>\n";
			}
		} elseif (strpos($a['type'], 'text/html') === 0) {
			// Only meta/link tags, each filtered; stray text would end <head> early.
			preg_match_all('/<(?:meta|link)\b[^>]*>/i', $a['content'], $tags);
			foreach ($tags[0] as $tag) {
				echo wp_kses($tag, ['meta' => ['name' => true, 'property' => true, 'content' => true], 'link' => ['rel' => true, 'href' => true]]) . "\n";
			}
		}
	}
}, 5);

/** Any stored file artifact for this exact path, whatever its content type. */
function boostloop_aeo_find_file($path) {
	foreach (boostloop_aeo_artifacts() as $a) {
		if ('file' === $a['placement'] && $a['path'] === $path) {
			return $a;
		}
	}
	return null;
}

function boostloop_aeo_send($type, $body) {
	status_header(200);
	header('Content-Type: ' . $type);
	header('X-Robots-Tag: noindex'); // the HTML page stays canonical
	header('Cache-Control: no-cache');
	echo $body; // phpcs:ignore WordPress.Security.EscapeOutput -- text, markdown, JSON or XML body, not HTML.
	exit;
}

/**
 * Serves the generated files (llms.txt, sitemap.xml, products.jsonld, pricing.md, the .md pages) and the owner's
 * commerce documents before WordPress routes the request, so no rewrite flush is needed and a site's own
 * /sitemap.xml redirect does not get in the way. Also answers `Accept: text/markdown` on a page with its .md twin.
 */
add_action('init', function () {
	$method = isset($_SERVER['REQUEST_METHOD']) ? sanitize_text_field(wp_unslash($_SERVER['REQUEST_METHOD'])) : 'GET';
	if (!in_array($method, ['GET', 'HEAD'], true) || (defined('REST_REQUEST') && REST_REQUEST) || wp_doing_ajax() || is_admin()) {
		return;
	}
	$path = boostloop_aeo_current_path();
	if ('/robots.txt' !== $path) {
		$a = boostloop_aeo_find_file($path);
		if ($a) {
			boostloop_aeo_send($a['type'], $a['content']);
		}
	}
	$doc = boostloop_aeo_commerce_document($path);
	if (null !== $doc) {
		boostloop_aeo_send('application/json; charset=utf-8', $doc);
	}
	$accept = isset($_SERVER['HTTP_ACCEPT']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_ACCEPT'])) : '';
	if (false !== stripos($accept, 'text/markdown') && '.md' !== substr($path, -3)) {
		$md = boostloop_aeo_find_file('/' === $path ? '/index.md' : $path . '.md');
		if ($md) {
			header('Vary: Accept');
			boostloop_aeo_send($md['type'], $md['content']);
		}
	}
}, 1);

/** Check 20 headers (homepage), and `Vary: Accept` so caches keep the markdown and HTML versions apart (check 18). */
add_action('send_headers', function () {
	$path = boostloop_aeo_current_path();
	$markdown = false;
	foreach (boostloop_aeo_artifacts() as $a) {
		if ('header' === $a['placement'] && $a['path'] === $path && 0 === strpos($a['content'], 'Link:')) {
			header(str_replace(["\r", "\n"], '', $a['content']), false);
		}
		$markdown = $markdown || ('file' === $a['placement'] && '.md' === substr($a['path'], -3));
	}
	if ($markdown) {
		header('Vary: Accept', false);
	}
});

/** Check 22: an unknown URL always answers 404, whatever the theme does (set by the fix). */
add_action('template_redirect', function () {
	if (get_option('boostloop_aeo_hard404') && is_404()) {
		status_header(404);
		nocache_headers();
	}
}, 99);

/** Checks 15 and 19: /llms.txt and the .md twins, served through rewrite rules (no files written). */
function boostloop_aeo_rewrites() {
	add_rewrite_rule('^(llms\.txt|.+\.md)$', 'index.php?boostloop_aeo_file=$matches[1]', 'top');
}
add_action('init', 'boostloop_aeo_rewrites');

add_filter('query_vars', function ($vars) {
	$vars[] = 'boostloop_aeo_file';
	return $vars;
});

// No trailing-slash redirect for /llms.txt and .md URLs.
add_filter('redirect_canonical', function ($redirect) {
	return get_query_var('boostloop_aeo_file') ? false : $redirect;
});

add_action('template_redirect', function () {
	$file = get_query_var('boostloop_aeo_file');
	if (!$file) {
		return;
	}
	$a = boostloop_aeo_find('file', boostloop_aeo_norm_path($file), substr($file, -3) === '.md' ? 'text/markdown' : 'text/plain');
	if (!$a) {
		global $wp_query;
		$wp_query->set_404();
		status_header(404);
		return;
	}
	status_header(200);
	header('Content-Type: ' . $a['type']);
	header('X-Robots-Tag: noindex'); // the HTML page stays canonical
	echo $a['content']; // phpcs:ignore WordPress.Security.EscapeOutput -- plain text / markdown body, not HTML
	exit;
}, 1);

register_activation_hook(__FILE__, function () {
	boostloop_aeo_rewrites();
	flush_rewrite_rules();
});

register_deactivation_hook(__FILE__, 'flush_rewrite_rules');
