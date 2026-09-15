import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClashSettings, parseProxyState } from '../agent/controls/network.js';

// `scutil --proxy` on this Mac with Clash Verge 2.5.2's system proxy on (2026-09-16).
const SCUTIL_ON = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 192.168.0.0/16
    2 : 10.0.0.0/8
    3 : 172.16.0.0/12
    4 : localhost
    5 : *.local
    6 : *.crashlytics.com
    7 : <local>
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`;
const SCUTIL_OFF = SCUTIL_ON.replace(/(HTTP|HTTPS|SOCKS)Enable : 1/g, '$1Enable : 0');
const CLASH = { host: '127.0.0.1', port: 7897, pac: false };

test('reads the proxy endpoint from Clash Verge settings', () => {
  const yaml = 'enable_system_proxy: true\nproxy_auto_config: false\nproxy_host: 127.0.0.1\nverge_mixed_port: 7897\nverge_socks_port: 7898\n';
  assert.deepEqual(parseClashSettings(yaml), CLASH);
  assert.deepEqual(parseClashSettings("verge_mixed_port: 7890\nproxy_host: '127.0.0.1'\n"), { ...CLASH, port: 7890 });
  assert.equal(parseClashSettings('proxy_auto_config: true\n').pac, true);
});

test('rejects endpoints that are not a plain host and port', () => {
  assert.equal(parseClashSettings('proxy_host: a;b\n'), null);
  assert.equal(parseClashSettings('verge_mixed_port: 99999\n'), null);
});

test('the system proxy counts as on only when it points at Clash Verge', () => {
  assert.deepEqual(parseProxyState(SCUTIL_ON, CLASH), { on: true, elsewhere: false });
  assert.deepEqual(parseProxyState(SCUTIL_OFF, CLASH), { on: false, elsewhere: false });
  const otherProxy = SCUTIL_ON.replace(/Port : 7897/g, 'Port : 8080');
  assert.deepEqual(parseProxyState(otherProxy, CLASH), { on: false, elsewhere: true });
});
