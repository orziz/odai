import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySessionControl, effectiveSessionRoute } from '../build/session-controls.mjs';
import { createSessionEvidence } from '../build/session-evidence.mjs';
test('session controls persist independently, consume lead gaps, and override only supported routes', () => {
 const root = mkdtempSync(join(tmpdir(), 'odai-controls-'));
 try {
  const route = { backend:'local-cli', cli:'claude', model:'opus' };
  const options = { configPath:join(root,'routing.json'), evidenceRoot:join(root,'evidence'), routingMode:'execute', configuredRoles:{planner:route, reviewer:{provider:'test',model:'test'}} };
  const call = (action, rest={}, sessionId='a') => applySessionControl({sessionId,action,...rest},options);
  const evidence=createSessionEvidence({root:options.evidenceRoot}); const agent={session:{header:{id:'a'}}};
  evidence.append(agent,'odai/responsibility-gap',{source:'lead-mode',stateDigest:'lead',responsibility:'planner'});
  evidence.append(agent,'odai/responsibility-gap',{source:'named',stateDigest:'named',responsibility:'planner'});
  assert.equal(call('set-lead',{enabled:true}).lead.enabled,true);
  assert.equal(call('show',{},'b').lead.enabled,false);
  assert.equal(call('show').lead.enabled,true);
  call('set-lead',{enabled:false});
  assert.deepEqual(evidence.events(agent).filter(e=>e.type==='odai/responsibility-gap-consumed').map(e=>e.data.stateDigest),['lead']);
  call('set-continuation',{value:'continue'});
  assert.equal(effectiveSessionRoute(route,agent,evidence).session,'continue');
  assert.equal(effectiveSessionRoute({...route,cli:'codex'},agent,evidence).session,undefined);
  assert.equal(call('show',{},'b').continuation.override,'inherit');
  call('set-continuation',{value:'fresh'});
  assert.equal(effectiveSessionRoute({...route,session:'continue'},agent,evidence).session,'fresh');
  call('set-continuation',{value:'inherit'});
  assert.equal(effectiveSessionRoute(route,agent,evidence),route);
  assert.equal(existsSync(options.configPath),false);
  const inherited = applySessionControl({sessionId:'inherited', action:'set-lead', enabled:true}, {...options, configuredRoles:{}});
  assert.equal(inherited.lead.enabled,true);
  assert.equal(inherited.lead.available,true);
  assert.deepEqual(inherited.lead.roles,['planner','reviewer']);
  assert.throws(()=>call('set-lead',{enabled:'true'}));
  assert.throws(()=>call('set-continuation',{value:'invalid'}));
  assert.throws(()=>applySessionControl({sessionId:'a',action:'set-lead',enabled:true},{...options,routingMode:'off'}));
 } finally { rmSync(root,{recursive:true,force:true}); }
});
