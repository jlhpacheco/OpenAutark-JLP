import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testNetworkEnv} from '../../../scripts/test-network-env.mjs';

const tainted = Object.freeze({
  PATH:'keep', Workforce_Test_DATA:'other', WORKFORCE_test_LAn:'1',
  WoRkFoRcE_Installer_Loopback_Policy:'inherited',
  workforce_discovery_targets:'192.0.2.1', WORKFORCE_TEST_LAN:'1',
});
test('neither parent nor generic options can set network policy, including Windows aliases',()=>{
  assert.deepEqual(testNetworkEnv('test',{...tainted,PATH:'override'},{inherited:tainted}),{
    PATH:'override', WORKFORCE_TEST_DATA:'test', WORKFORCE_TEST_LAN:'0',
  });
  assert.equal(tainted.WORKFORCE_TEST_LAN,'1');
});
test('start options do not implicitly enable LAN',()=>{
  for (const lan of [false,'true','1',1,null,undefined])
    assert.equal(testNetworkEnv('test',null,{inherited:tainted,lan}).WORKFORCE_TEST_LAN,'0');
  assert.equal(testNetworkEnv('test',null,{inherited:tainted,lan:true}).WORKFORCE_TEST_LAN,'1');
});
test('explicit discovery preserves loopback route ordering and stays local',()=>{
  assert.equal(testNetworkEnv('test',null,{inherited:tainted,discovery:'127.0.0.3, 127.0.0.2'}).WORKFORCE_DISCOVERY_TARGETS,'127.0.0.3,127.0.0.2');
});
test('invalid discovery or implicit profiles fail predictably before process creation',()=>{
  for(const discovery of ['',false,'localhost','127.1','127.0.0.1,0.0.0.0','192.0.2.1','::','127.0.0.1,','127.0.0.999'])
    assert.throws(()=>testNetworkEnv('test',null,{inherited:tainted,discovery}),/loopback/);
  for (const profile of ['',null,' ', 'test\0bad'])
    assert.throws(()=>testNetworkEnv(profile,{}, {inherited:tainted}),/Explicit test profile/);
});
