import {randomUUID} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {access} from 'node:fs/promises';
import {requireThat} from './device-session.mjs';

const sessionBindings=new WeakMap();
/** Read-only provenance for the exact routing session used by this connection. */
export function getClientSessionBinding(client) { return sessionBindings.get(client); }

/** Attaches to a running service. Never starts/restarts a daemon or changes approvals. */
export async function connectPair({repo,stateDirectory,env=process.env}) {
  requireThat(isAbsolute(repo??'')&&isAbsolute(stateDirectory??''),'absolute_existing_repo_and_state_required');
  await access(join(repo,'src/stdio.mjs'));
  const resolveFromRepo=createRequire(join(repo,'package.json'));
  const {Client}=await import(pathToFileURL(resolveFromRepo.resolve('@modelcontextprotocol/client')).href);
  const {StdioClientTransport}=await import(pathToFileURL(resolveFromRepo.resolve('@modelcontextprotocol/client/stdio')).href);
  const clients=[],connectionGroup=randomUUID();
  try {
    for(let i=0;i<2;i++) {
      const client=new Client({name:`poki-dual-phone-${i}`,version:'1.0.0'});
      clients.push(client);
      const sessionId=`dual-phone-${i}-${randomUUID()}`;
      // Only routing/session values are supplied. Existing daemon approval behavior
      // remains authoritative and each client checks ask-human before acquisition.
      await client.connect(new StdioClientTransport({command:process.execPath,args:[join(repo,'src/stdio.mjs')],
        env:{...env,POKI_MCP_STATE_DIR:stateDirectory,POKI_MCP_SESSION:sessionId}}));
      sessionBindings.set(client,Object.freeze({source:'connectPair',connection_group:connectionGroup,client_session_id:sessionId}));
    }
    return clients;
  } catch(error) { await Promise.allSettled(clients.map(c=>c.close()));throw error; }
}
