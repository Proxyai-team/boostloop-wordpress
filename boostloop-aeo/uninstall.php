<?php
if (!defined('WP_UNINSTALL_PLUGIN')) {
	exit;
}

// Plugin functions are not loaded here. Put back the physical files and site settings the fixes changed.
$written = get_option('boostloop_aeo_written', []);
foreach (is_array($written) ? array_keys($written) : [] as $path) {
	$file = untrailingslashit(ABSPATH) . $path;
	if (is_file($file . '.boostloop-bak')) {
		@rename($file . '.boostloop-bak', $file); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions
	}
}
$prior = get_option('boostloop_aeo_options_prior', []);
foreach (is_array($prior) ? $prior : [] as $name => $value) {
	if (in_array($name, ['blog_public', 'boostloop_aeo_hard404'], true)) {
		null === $value ? delete_option($name) : update_option($name, $value);
	}
}

foreach (['boostloop_aeo_secret', 'boostloop_aeo_artifacts', 'boostloop_aeo_written', 'boostloop_aeo_section', 'boostloop_aeo_commerce', 'boostloop_aeo_options_prior', 'boostloop_aeo_hard404', 'boostloop_aeo_api_url', 'boostloop_aeo_key', 'boostloop_aeo_pending', 'boostloop_aeo_scan_id', 'boostloop_aeo_bundle_id'] as $option) {
	delete_option($option);
}
