<?php
/**
 * Uninstall: put back the physical files and site settings the fixes changed, then delete the plugin's options.
 *
 * @package boostloop-aeo
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

/** Plugin functions are not loaded here, so this stays self-contained. */
function boostloop_aeo_uninstall() {
	$written = get_option( 'boostloop_aeo_written', array() );
	foreach ( is_array( $written ) ? array_keys( $written ) : array() as $path ) {
		$file = untrailingslashit( ABSPATH ) . $path; // phpcs:ignore PluginCheck.CodeAnalysis.WriteFile.ABSPATHDetected -- restoring the original site-root file.
		if ( is_file( $file . '.boostloop-bak' ) ) {
			@rename( $file . '.boostloop-bak', $file ); // phpcs:ignore PluginCheck.CodeAnalysis.WriteFile.ABSPATHDetected, WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions
		}
	}
	$prior = get_option( 'boostloop_aeo_options_prior', array() );
	foreach ( is_array( $prior ) ? $prior : array() as $name => $value ) {
		if ( in_array( $name, array( 'blog_public', 'boostloop_aeo_hard404' ), true ) ) {
			null === $value ? delete_option( $name ) : update_option( $name, $value );
		}
	}

	$options = array( 'boostloop_aeo_secret', 'boostloop_aeo_artifacts', 'boostloop_aeo_written', 'boostloop_aeo_section', 'boostloop_aeo_commerce', 'boostloop_aeo_options_prior', 'boostloop_aeo_hard404', 'boostloop_aeo_api_url', 'boostloop_aeo_key', 'boostloop_aeo_pending', 'boostloop_aeo_scan_id', 'boostloop_aeo_bundle_id' );
	foreach ( $options as $option ) {
		delete_option( $option );
	}
}

boostloop_aeo_uninstall();
