import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requestSchema } from '../ui/src/lib/folio/schema.ts';

// Commands only the iPhone sync route may send (never the renderer): whole chats, attachment bytes, Bella audio.
const syncCommandSchema = z.object({
  command: z.enum(['chat-list', 'chat-put', 'asset-read', 'asset-write', 'bella']),
  noteID: z.string().uuid().optional(),
  text: z.string().max(60_000_000).optional(),
  kind: z.string().max(300).optional(),
  rate: z.number().finite().optional(),
}).strict();

// Routing envelope only; the renderer validates the full notebook state.
const envelopeSchema = z.object({ id: z.string(), ok: z.boolean() }).passthrough();

// One child owns the Mac notebook. No shell, listening socket, or remote API.
export function createFolioEngine({ resourcesPath, developmentRoot, libraryPath, platform = process.platform }) {
  let child = null;
  const pending = new Map();
  function failAll(error) { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); }
  function start() {
    if (platform !== 'darwin') throw new Error('Folio requires macOS 15 or later.');
    if (child) return child;
    const candidates=[path.join(resourcesPath,'folio','Folio Engine.app','Contents','MacOS','Folio'),path.join(developmentRoot,'resources','folio','Folio Engine.app','Contents','MacOS','Folio'),path.join(developmentRoot,'..','resources','folio','Folio Engine.app','Contents','MacOS','Folio')];
    const executable=candidates.find(existsSync);
    if (!executable) throw new Error('The Folio engine is missing. Build native/Folio before opening the notebook.');
    const processChild=spawn(executable, ['--library',libraryPath], {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{HOME:process.env.HOME,PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:process.env.LANG}});
    child=processChild;
    const lines=createInterface({input:processChild.stdout});
    // The renderer fully validates responses; the main process only routes them, so large notebooks never stall OpenChamber's server.
    lines.on('line',line=>{
      try { const result=envelopeSchema.parse(JSON.parse(line));const request=pending.get(result.id);if(!request)return;clearTimeout(request.timer);pending.delete(result.id);request.resolve(result); }
      catch { failAll(new Error('Folio returned an invalid response. Your saved library has not been reset.')); }
    });
    // A stopped engine surfaces as a failed request, never an uncaught EPIPE in the main process.
    processChild.stdin.on('error',()=>{});
    // Native frameworks write diagnostics here. Drain them, never log note data.
    processChild.stderr.on('data',()=>{});
    processChild.on('error',()=>{child=null;failAll(new Error('Folio could not start.'));});
    processChild.on('exit',()=>{if(child===processChild)child=null;lines.close();failAll(new Error('Folio stopped. Reopen the notebook to reconnect.'));});
    return processChild;
  }
  async function request(input) { return send(requestSchema.parse(input)); }
  async function syncRequest(input) { return send(syncCommandSchema.parse(input)); }
  async function send(payload) {
    const processChild=start(),id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Folio is still waiting for a native operation. Check its open dialog before retrying.'));},300_000);
      pending.set(id,{resolve,reject,timer});
      processChild.stdin.write(JSON.stringify({...payload,id})+'\n',error=>{if(error){clearTimeout(timer);pending.delete(id);reject(new Error('Could not send the operation to Folio.'));}});
    });
  }
  async function stop() {
    if(!child)return;
    const processChild=child;
    const result=await request({command:'shutdown'});
    if(!result.ok)throw new Error(result.error || 'Folio could not save before quitting.');
    processChild.stdin.end();
    await new Promise(resolve=>{if(processChild.exitCode!==null)return resolve();const timer=setTimeout(()=>{processChild.kill('SIGTERM');resolve();},5000);processChild.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
  return { request,syncRequest,stop };
}
