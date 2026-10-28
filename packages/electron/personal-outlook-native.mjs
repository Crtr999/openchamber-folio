import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { z } from 'zod';

const identitySchema = z.object({ id: z.string().min(1).max(2000), address: z.string().email() });
const resultSchema = z.object({ access: z.enum(['connected', 'not-connected', 'unsupported', 'error']), accounts: z.array(identitySchema).max(50).default([]), records: z.array(z.object({ id: z.string().max(4096), title: z.string().max(2000), text: z.string().max(6000), truncated: z.boolean() })).max(100).default([]), health: z.array(z.object({ address: z.string().email(), status: z.enum(['partial', 'error', 'needs-connection']) })).max(5).default([]), reason: z.enum(['permission', 'accounts-unavailable', 'scripting-error', 'not-installed']).optional() });

// Fixed read-only JXA program. Inputs are JSON data, never AppleScript fragments.
// Permission is checked without prompting except during an explicit Connect.
const script = String.raw`
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
ObjC.bindFunction('malloc', ['void *', ['long']]);
ObjC.bindFunction('free', ['void', ['void *']]);
ObjC.bindFunction('AECreateDesc', ['int', ['uint32', 'void *', 'long', 'void *']]);
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'uint32', 'uint32', 'bool']]);
ObjC.bindFunction('AEDisposeDesc', ['int', ['void *']]);
function permission(prompt) {
  var target = $.malloc(16);
  var data = $('com.microsoft.Outlook').dataUsingEncoding($.NSUTF8StringEncoding);
  var created = $.AECreateDesc(0x62756e64, data.bytes, data.length, target);
  try { return created === 0 ? $.AEDeterminePermissionToAutomateTarget(target, 0x636f7265, 0x67657464, prompt) : created; }
  finally { if (created === 0) $.AEDisposeDesc(target); $.free(target); }
}
function main(input) {
  if (input.op === 'connect') Application('com.microsoft.Outlook').launch();
  if (permission(input.op === 'connect') !== 0) return {access:'not-connected', reason:'permission'};
  var app = Application('com.microsoft.Outlook');
  var identities = [], live = {}, failures = 0;
  ['exchangeAccounts', 'imapAccounts', 'popAccounts'].forEach(function(kind) {
    try {
      var values = app[kind]();
      for (var i = 0; i < Math.min(values.length, 50); i++) {
        var account = values[i];
        var address = String(account.emailAddress()).toLowerCase();
        var id = kind + ':' + String(account.id());
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) continue;
        if (identities.some(function(item) { return item.address === address; })) continue;
        if (identities.length >= 50) break;
        identities.push({id:id,address:address}); live[id] = account;
      }
    } catch (_) { failures++; }
  });
  // Some Outlook modes expose account references only through their folders.
  // Use the explicit account identity, never a folder name or UI selection.
  if (!identities.length) {
    try {
      var folders = app.mailFolders();
      for (var f = 0; f < Math.min(folders.length,50); f++) {
        try {
          var folderAccount = folders[f].account();
          var folderAddress = String(folderAccount.emailAddress()).toLowerCase();
          var folderId = 'folderAccount:' + String(folderAccount.id());
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(folderAddress)) continue;
          if (identities.some(function(item) {return item.address === folderAddress;})) continue;
          identities.push({id:folderId,address:folderAddress}); live[folderId] = folderAccount;
        } catch (_) {}
      }
    } catch (_) {}
  }
  if (!identities.length) return {access:'unsupported', reason: failures === 3 ? 'scripting-error' : 'accounts-unavailable'};
  if (input.op === 'connect' || input.op === 'probe') return {access:'connected',accounts:identities};
  var records = [], health = [];
  function record(address, kind, item) {
    var text = JSON.stringify({account:address,kind:kind,data:item,coverage:'local Outlook snapshot; recurring calendar expansion is not available'});
    records.push({id:(address+':native:'+kind+':'+item.id).slice(0,4096),title:item.subject.slice(0,2000),text:text.slice(0,6000),truncated:true});
  }
  input.accounts.forEach(function(selected) {
    var identity = identities.filter(function(item) {return item.id === selected.id && item.address === selected.address.toLowerCase();})[0];
    if (!identity) { health.push({address:selected.address,status:'needs-connection'}); return; }
    var account = live[identity.id], completed = 0;
    try {
      var messages = account.inbox().messages.whose({timeReceived:{_greaterThan:new Date(input.now-14*86400000)}});
      var count = messages.length;
      for (var m = 0; m < Math.min(count,10); m++) {
        try {
          var message = messages.at(m), body = '';
          try { if (!message.isPartiallyDownloaded()) body = String(message.plainTextContent()).slice(0,3000); } catch (_) {}
          record(identity.address,'mail',{id:String(message.id()),subject:String(message.subject()),receivedAt:message.timeReceived().toISOString(),isRead:message.isRead(),preview:body});
        } catch (_) {}
      }
      completed++;
    } catch (_) {}
    try {
      var calendars = account.calendars(), remaining = 10;
      for (var c = 0; c < Math.min(calendars.length,20) && remaining > 0; c++) {
        try {
        var events = calendars[c].calendarEvents.whose({_and:[{startTime:{_lessThan:new Date(input.now+7*86400000)}},{endTime:{_greaterThan:new Date(input.now)}}]});
        var eventCount = events.length;
        for (var e = 0; e < Math.min(eventCount,remaining); e++) {
          try {
            var event = events.at(e);
            record(identity.address,'calendar',{id:String(event.id()),subject:String(event.subject()),start:event.startTime().toISOString(),end:event.endTime().toISOString(),allDay:event.allDayFlag(),recurring:event.isRecurring()});
          } catch (_) {}
        }
        remaining -= Math.min(eventCount,remaining);
        } catch (_) {}
      }
      completed++;
    } catch (_) {}
    // Local caches and unexpanded recurrences cannot prove complete cloud coverage.
    health.push({address:identity.address,status:completed ? 'partial' : 'error'});
  });
  return {access:'connected',accounts:identities,records:records,health:health};
}
try { JSON.stringify(main(INPUT)); }
catch (_) { JSON.stringify({access:'error',reason:'scripting-error'}); }
`;

const runScript = (input) => new Promise((resolve, reject) => {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let settled = false;
  const fail = () => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(new Error('Could not read native Outlook.')); };
  const timer = setTimeout(fail, input.op === 'connect' ? 100000 : 20000);
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.resume();
  child.stdout.on('data', (chunk) => { output += chunk.toString(); if (output.length > 2000000) fail(); });
  child.on('close', (code) => {
    if (settled) return;
    if (code !== 0) { fail(); return; }
    settled = true; clearTimeout(timer);
    try { resolve(JSON.parse(output)); } catch { reject(new Error('Native Outlook returned an unreadable response.')); }
  });
  child.stdin.end(`var INPUT = ${JSON.stringify(input)};\n${script}`);
});

export function createNativeOutlook({ platform = process.platform, run = runScript, installed = async () => { try { await access('/Applications/Microsoft Outlook.app/Contents/Info.plist'); return true; } catch { return false; } }, isBlocked, now = Date.now }) {
  const available = async () => platform === 'darwin' && await installed();
  const call = async (op, accounts = []) => {
    if (!await available()) return resultSchema.parse({ access: 'unsupported', reason: 'not-installed' });
    if (isBlocked()) throw new Error('Outlook is unavailable in enterprise mode.');
    const selected = z.array(identitySchema).max(5).parse(accounts);
    const result = resultSchema.parse(await run({ op, accounts: selected, now: now() }));
    if (isBlocked()) throw new Error('Outlook is unavailable in enterprise mode.');
    if (op === 'read' && result.access === 'connected' && selected.some((account) => !result.health.some((item) => item.address.toLowerCase() === account.address.toLowerCase()))) throw new Error('Native Outlook returned incomplete source coverage.');
    return result;
  };
  return { available, connect: () => call('connect'), probe: () => call('probe'), read: (accounts) => call('read', accounts) };
}
