<?php
/**
 * Commerce discovery documents (checks 32-36: UCP, ACP, AP2, MPP, x402). The values are entered by the site owner and
 * stay in this site's options; BoostLoop only charges for saving them and never sees them. Each document is a plain
 * JSON discovery file built from those values, served at its well-known path. Publishing it does not make the shop
 * speak the protocol: the endpoints entered must be real.
 */

if (!defined('ABSPATH')) {
	exit;
}

/** check id => well-known path, label, fields (key => [label, type, required]). */
function boostloop_aeo_commerce_defs() {
	return [
		32 => ['path' => '/.well-known/ucp', 'fields' => ['checkout_endpoint' => ['url', true], 'catalog_endpoint' => ['url', false], 'contact_email' => ['email', false]]],
		33 => ['path' => '/.well-known/acp.json', 'fields' => ['api_base_url' => ['url', true], 'contact_email' => ['email', false]]],
		34 => ['path' => '/.well-known/ap2.json', 'fields' => ['endpoint' => ['url', true], 'payment_methods' => ['list', true]]],
		35 => ['path' => '/.well-known/mpp', 'fields' => ['payment_endpoint' => ['url', true], 'accepted_methods' => ['list', true]]],
		36 => ['path' => '/.well-known/x402', 'fields' => ['network' => ['text', true], 'pay_to' => ['text', true], 'asset' => ['text', true], 'max_amount' => ['amount', true], 'resource_url' => ['url', true]]],
	];
}

function boostloop_aeo_commerce_saved() {
	$saved = get_option('boostloop_aeo_commerce', []);
	return is_array($saved) ? $saved : [];
}

/** Clean values for one check, or a WP_Error naming the first bad field. */
function boostloop_aeo_commerce_clean($check_id, $input) {
	$defs = boostloop_aeo_commerce_defs();
	if (!isset($defs[$check_id]) || !is_array($input)) {
		return new WP_Error('boostloop_commerce', 'Unknown setup', ['status' => 400]);
	}
	$out = [];
	foreach ($defs[$check_id]['fields'] as $key => $rule) {
		list($type, $required) = $rule;
		$raw = isset($input[$key]) ? trim((string) $input[$key]) : '';
		if ('' === $raw) {
			if ($required) {
				return new WP_Error('boostloop_commerce', $key . ' is required', ['status' => 400]);
			}
			continue;
		}
		if (strlen($raw) > 300) {
			return new WP_Error('boostloop_commerce', $key . ' is too long', ['status' => 400]);
		}
		if ('url' === $type) {
			$value = esc_url_raw($raw, ['https']);
			if ('' === $value || 'https' !== wp_parse_url($value, PHP_URL_SCHEME)) {
				return new WP_Error('boostloop_commerce', $key . ' must be an https:// URL', ['status' => 400]);
			}
		} elseif ('email' === $type) {
			$value = sanitize_email($raw);
			if (!is_email($value)) {
				return new WP_Error('boostloop_commerce', $key . ' must be an email address', ['status' => 400]);
			}
		} elseif ('amount' === $type) {
			if (!preg_match('/^\d{1,30}$/', $raw)) {
				return new WP_Error('boostloop_commerce', $key . ' must be a whole number (smallest unit)', ['status' => 400]);
			}
			$value = $raw;
		} else {
			$value = sanitize_text_field($raw);
		}
		$out[$key] = $value;
	}
	return $out;
}

/** The JSON document for a well-known path, or null when none is set up for it. */
function boostloop_aeo_commerce_document($path) {
	$saved = boostloop_aeo_commerce_saved();
	foreach (boostloop_aeo_commerce_defs() as $id => $def) {
		if ($def['path'] !== $path || empty($saved[$id])) {
			continue;
		}
		$v = $saved[$id];
		$merchant = ['name' => get_bloginfo('name'), 'url' => home_url('/')] + (isset($v['contact_email']) ? ['contact' => $v['contact_email']] : []);
		$list = function ($s) {
			return array_values(array_filter(array_map('trim', explode(',', (string) $s))));
		};
		switch ($id) {
			case 32:
				$doc = ['protocol' => 'ucp', 'merchant' => $merchant, 'endpoints' => array_filter(['checkout' => $v['checkout_endpoint'], 'catalog' => isset($v['catalog_endpoint']) ? $v['catalog_endpoint'] : null])];
				break;
			case 33:
				$doc = ['protocol' => 'acp', 'merchant' => $merchant, 'api_base_url' => $v['api_base_url']];
				break;
			case 34:
				$doc = ['protocol' => 'ap2', 'merchant' => $merchant, 'endpoint' => $v['endpoint'], 'payment_methods' => $list($v['payment_methods'])];
				break;
			case 35:
				$doc = ['protocol' => 'mpp', 'merchant' => $merchant, 'payment_endpoint' => $v['payment_endpoint'], 'accepted_methods' => $list($v['accepted_methods'])];
				break;
			default:
				$doc = ['x402Version' => 1, 'accepts' => [['scheme' => 'exact', 'network' => $v['network'], 'payTo' => $v['pay_to'], 'asset' => $v['asset'], 'maxAmountRequired' => $v['max_amount'], 'resource' => $v['resource_url']]]];
		}
		return wp_json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n";
	}
	return null;
}

add_action('rest_api_init', function () {
	// Owner-only: read back what was saved (to prefill the form), save after the karma charge, or remove a document.
	register_rest_route('boostloop/v1', '/commerce', [
		'methods' => ['GET', 'POST', 'DELETE'],
		'permission_callback' => 'boostloop_aeo_can_manage',
		'callback' => function (WP_REST_Request $request) {
			$saved = boostloop_aeo_commerce_saved();
			if ('GET' === $request->get_method()) {
				return (object) $saved;
			}
			$params = $request->get_json_params();
			$id = is_array($params) && isset($params['check_id']) ? (int) $params['check_id'] : 0;
			if ('DELETE' === $request->get_method()) {
				unset($saved[$id]);
				update_option('boostloop_aeo_commerce', $saved, false);
				return (object) $saved;
			}
			$clean = boostloop_aeo_commerce_clean($id, is_array($params) && isset($params['fields']) ? $params['fields'] : null);
			if (is_wp_error($clean)) {
				return $clean;
			}
			$saved[$id] = $clean;
			update_option('boostloop_aeo_commerce', $saved, false);
			$defs = boostloop_aeo_commerce_defs();
			// Same public view a crawler gets: a CDN may still be serving the old (missing) answer for this path.
			$live = wp_remote_get(home_url($defs[$id]['path']), ['timeout' => 10, 'redirection' => 0, 'user-agent' => 'BoostLoop-Plugin/' . BOOSTLOOP_AEO_VERSION]);
			$stale = !is_wp_error($live) && trim(wp_remote_retrieve_body($live)) !== trim((string) boostloop_aeo_commerce_document($defs[$id]['path']));
			return ['saved' => true, 'url' => home_url($defs[$id]['path']), 'stale' => $stale, 'cache' => $stale && !is_wp_error($live) ? (string) wp_remote_retrieve_header($live, 'cf-cache-status') : ''];
		},
	]);
});
