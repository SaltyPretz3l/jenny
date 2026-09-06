'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {INIT_CHANNEL,DECIDE_CHANNEL}=require('../services/main/plugin-consent-window');
test('isolated consent document has fixed CSP, truthful copy, and acknowledgment gate',()=>{const html=fs.readFileSync(path.join(__dirname,'..','plugin-consent.html'),'utf8');assert.match(html,/default-src 'none'/);assert.match(html,/Plugin content cannot appear here/);assert.match(html,/not sandboxed/);assert.match(html,/cannot revoke bytes already observed/);assert.match(html,/id="approve" type="button" disabled/);assert.equal(INIT_CHANNEL,'plugin-consent:initialize');assert.equal(DECIDE_CHANNEL,'plugin-consent:decide');});
