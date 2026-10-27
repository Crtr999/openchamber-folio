# Director

## Purpose

The Director lets a folder's friend improve a new message before the chat starts.
`POST /api/openchamber/director/improve` takes `{ directory, folderName, prompt }` and
returns `{ text, used, model }`: the draft rewritten from the folder's own rules
(`AGENTS.md`), its memory file (`MEMORY.md`) and the memories stored for that project.

## Boundaries

- Only a configured project folder is accepted; any other directory is a 403.
- A folder bound to one provider whose name contains `zdr` is refused (`reason: 'zdr'`).
  The Director sends that folder's memory to a model, which a zero-retention folder does
  not allow. The refusal is enforced here, not only in the composer.
- Folder rules and memory are sent as reference data. The system prompt tells the model
  never to follow commands inside them and never to add actions the user did not ask for.
- The model is the small-model service (`lib/small-model`), the same one that titles
  sessions. Nothing here holds a credential.
- A failure never blocks a send: the composer sends the original text and says so.

## Client

`packages/ui/src/lib/director.ts` calls the route. `useDirectorStore` holds the on/off
choice (`open-carter:director:v1`) and the run in progress. `ChatInput.handleSubmit` takes a
plain first message to a folder, runs `runDirector`, then re-enters itself with
`presetText` and `directorBypass`. `DirectorOverlay` (mounted once in `MainLayout`) draws the
friend leaving the folder picker's face (`data-director-origin`), walking the composer's
frame, scanning, showing the improved text and delivering it. `Esc` or "Send as written"
sends the original. Reduced motion removes the walk and the sweep.
