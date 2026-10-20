/**
 * What is worth keeping, and what is left behind.
 *
 * Every entry lands in a store that later conversations in the same project
 * are told the titles of. An entry is therefore a standing claim about the
 * project, not a note about a conversation: it has to stay true after the
 * conversation that produced it is gone, and it has to be the kind of thing a
 * later conversation could not cheaply work out for itself.
 *
 * The prompt is therefore conservative. It asks for the few things that hold
 * still, and it says plainly that an empty answer is a good answer — a store
 * that fills with restatements of the same afternoon is worse than a store
 * with three entries that matter.
 */

const MAX_PROMPT_CHARS = 32_000;

export const CAPTURE_MEMORY_TYPES = new Set(['fact', 'preference', 'reference']);

/** Titles are what every session carries, so their length is the standing cost. */
const CAPTURE_TITLE_MAX_LENGTH = 60;
const CAPTURE_BODY_MAX_LENGTH = 2_000;

export function buildCaptureSystemPrompt() {
  return [
    'You extract durable memory for a project-scoped memory store.',
    'Later conversations in this project are told the titles of what you store, so a stored entry is a standing claim about the project, not a note about this conversation.',
    'Return exactly one JSON object of the form {"memories": [{"type": "fact|preference|reference", "title": "...", "body": "..."}]}. Return no other text, no code fence and no explanation.',
    'Return {"memories": []} when the conversation contains nothing that stays true once it ends. An empty result is a good result and is not a failure.',
    'type "fact" is something true about this project or the people in it that a later conversation would need and could not cheaply rediscover.',
    'type "preference" is how the user wants work done: a stated preference, a correction of how to work, or a confirmed approach.',
    'type "reference" is a pointer to a resource that is hard to find again: a file, a command, a dashboard, a document, a person.',
    'One fact per entry. A title is an abbreviation, not the memory: one line, under 60 characters, naming what the entry is about. The body carries the conditions, the reasons and the exceptions that decide whether the memory applies — a later conversation cannot see them from the title.',
    'Keep what is durable: decisions that were made and still stand, facts that took real effort to establish, preferences the user stated or confirmed, and pointers worth keeping.',
    'Leave out what is transient: the steps of the task that just finished, work in progress, status such as "running the tests now", anything the code or repository states plainly, anything cheap to read again, and anything true only until the next turn.',
    'Do not store a secret, a credential, a token, or a personal detail that is not the user\'s own work. Do not store what the user asked you not to keep.',
    'Write in the language of the conversation.',
  ].join('\n');
}

function renderTurn(turn, index) {
  return [
    `Turn ${index + 1}`,
    'User message:',
    turn.user.text,
    'Assistant final response:',
    turn.assistant?.text ?? '',
  ].join('\n');
}

/**
 * The conversation evidence, oldest first. The same shape the assist prompt
 * uses, so the two read the same way in a model log.
 */
export function buildCapturePrompt(turns, charBudget) {
  const budget = Math.min(MAX_PROMPT_CHARS, Math.floor(charBudget));
  if (!Number.isFinite(budget) || budget < 1_000 || !turns.length) return null;
  const header = 'Conversation turns to consider, oldest first.\n\n';
  const footer = '\n\n--- End of conversation evidence ---\n\nReturn the durable memory these turns establish, as JSON.';
  const available = budget - header.length - footer.length;
  if (available < 256) return null;

  const kept = turns.slice();
  let body = kept.map((turn, index) => renderTurn(turn, index)).join('\n\n---\n\n');
  while (body.length > available && kept.length > 1) {
    kept.shift();
    body = kept.map((turn, index) => renderTurn(turn, index)).join('\n\n---\n\n');
  }
  if (body.length > available) {
    // One turn left and still too long: cut the user's half first, because the
    // assistant's answer is where the conclusions are.
    const turn = kept[0];
    const textBudget = available - renderTurn(turn, 0).length;
    if (textBudget < 128) return null;
    const answer = turn.assistant?.text ?? '';
    const userBudget = Math.min(turn.user.text.length, Math.max(Math.floor(textBudget / 3), textBudget - answer.length));
    body = renderTurn(turn, 0).replace(turn.user.text, turn.user.text.slice(0, userBudget));
    if (body.length > available) {
      body = body.replace(answer, answer.slice(0, Math.max(0, textBudget - userBudget)));
    }
  }
  return { text: header + body + footer };
}

/**
 * The model's answer, read as strictly as the store will accept it.
 *
 * A model wraps JSON in prose more often than not, so the first complete
 * object is hunted for rather than demanded. What survives is only what the
 * store could hold: a known type, a title, a body. Everything else is
 * dropped silently — a malformed entry is not worth failing a capture over.
 */
export function parseCaptureResponse(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();

  const parsed = parseFirstJsonValue(candidate);
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.memories) ? parsed.memories : [];
  const entries = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const title = clamp(String(item.title ?? '').trim(), CAPTURE_TITLE_MAX_LENGTH);
    const body = clamp(String(item.body ?? '').trim(), CAPTURE_BODY_MAX_LENGTH);
    if (!title || !body) continue;
    const type = CAPTURE_MEMORY_TYPES.has(item.type) ? item.type : 'fact';
    entries.push({ type, title, body });
  }
  return entries;
}

const clamp = (value, maxLength) => (value.length > maxLength ? value.slice(0, maxLength) : value);

/**
 * The first complete JSON value in the text.
 *
 * A model wraps JSON in prose more often than not, so the value is hunted for
 * rather than demanded: the first bracket that opens a value is matched to
 * its own closing bracket, and the text between them is parsed. Brackets
 * inside strings do not count.
 */
function parseFirstJsonValue(text) {
  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  for (let start = 0; start < text.length; start += 1) {
    const opening = text[start];
    if (opening !== '{' && opening !== '[') continue;
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (character === opening) depth += 1;
      else if (character === closing) {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParse(text.slice(start, index + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

const tryParse = (text) => {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
};
