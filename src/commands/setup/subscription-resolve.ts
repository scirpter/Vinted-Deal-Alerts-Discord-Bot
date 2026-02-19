import { err, ok, type Result } from 'neverthrow';
import { listSubscriptions, type Subscription } from '../../services/subscription-service.js';

const CHANNEL_MENTION_RE = /^<#(\d+)>$/;
const CHANNEL_ID_RE = /^\d{17,20}$/;
const ID_TOKEN_RE = /^[0-9a-z]{6,26}$/i;
const TOKEN_IN_PARENS_RE = /\(([0-9a-z]{6,26})\)\s*$/i;

function parseChannelId(value: string): string | null {
  const trimmed = value.trim();
  const mention = CHANNEL_MENTION_RE.exec(trimmed);
  if (mention?.[1]) return mention[1];
  if (CHANNEL_ID_RE.test(trimmed)) return trimmed;
  return null;
}

function parseIdToken(value: string): string | null {
  const trimmed = value.trim();
  const parens = TOKEN_IN_PARENS_RE.exec(trimmed)?.[1];
  if (parens && ID_TOKEN_RE.test(parens)) return parens;
  if (ID_TOKEN_RE.test(trimmed)) return trimmed;
  return null;
}

export function buildSubscriptionIdTokens(
  subs: readonly Pick<Subscription, 'id'>[],
  minLength = 8,
): Map<string, string> {
  const ids = subs.map((s) => s.id);
  const lengths = new Map<string, number>(
    ids.map((id) => [id, Math.min(Math.max(minLength, 1), id.length)]),
  );

  const maxLen = Math.max(...ids.map((id) => id.length), minLength);

  while (true) {
    const groups = new Map<string, string[]>();
    for (const id of ids) {
      const len = lengths.get(id) ?? minLength;
      const token = id.slice(0, Math.min(len, id.length)).toLowerCase();
      const bucket = groups.get(token);
      if (bucket) bucket.push(id);
      else groups.set(token, [id]);
    }

    const duplicates = Array.from(groups.values()).filter((bucket) => bucket.length > 1);
    if (duplicates.length === 0) break;

    let progressed = false;
    for (const bucket of duplicates) {
      for (const id of bucket) {
        const current = lengths.get(id) ?? minLength;
        if (current < Math.min(maxLen, id.length)) {
          lengths.set(id, current + 1);
          progressed = true;
        }
      }
    }

    if (!progressed) break;
  }

  return new Map(
    ids.map((id) => [id, id.slice(0, Math.min(lengths.get(id) ?? minLength, id.length))]),
  );
}

function formatSubscriptionList(subs: Subscription[], tokens: Map<string, string>): string {
  const shown = subs.slice(0, 5).map((s) => {
    const token = tokens.get(s.id) ?? s.id;
    return `- ${s.label} (${token})`;
  });
  const more = subs.length > 5 ? `\n+${subs.length - 5} weitere` : '';
  return `${shown.join('\n')}${more}`;
}

export async function resolveSubscriptionReference(input: {
  discordGuildId: string;
  discordUserId: string;
  raw: string;
}): Promise<Result<Subscription, Error>> {
  const subs = await listSubscriptions({
    discordGuildId: input.discordGuildId,
    discordUserId: input.discordUserId,
  });

  if (subs.isErr()) return err(subs.error);
  if (subs.value.length === 0) {
    return err(new Error('Du hast noch keine Abos in diesem Server. Nutze `/setup subscription add`.'));
  }

  const trimmed = input.raw.trim();
  const normalized = trimmed.toLowerCase();

  const byId = subs.value.find((s) => s.id.toLowerCase() === normalized);
  if (byId) return ok(byId);

  const idToken = parseIdToken(trimmed);
  if (idToken) {
    const matches = subs.value.filter((s) => s.id.toLowerCase().startsWith(idToken.toLowerCase()));
    if (matches.length === 1) return ok(matches[0]!);
    if (matches.length > 1) {
      const tokens = buildSubscriptionIdTokens(matches);
      return err(
        new Error(
          `Mehrere Abos passen zu "${idToken}". Bitte nutze einen längeren Code oder wähle ein Abo aus der Autovervollständigung:\n${formatSubscriptionList(
            matches,
            tokens,
          )}`,
        ),
      );
    }
  }

  const channelId = parseChannelId(trimmed);
  if (channelId) {
    const byChannel = subs.value.filter((s) => s.discordChannelId === channelId);
    if (byChannel.length === 1) return ok(byChannel[0]!);
    if (byChannel.length > 1) {
      const tokens = buildSubscriptionIdTokens(byChannel);
      return err(
        new Error(
          `Mehrere Abos posten in <#${channelId}>. Bitte wähle ein Abo aus der Autovervollständigung oder nutze den Code:\n${formatSubscriptionList(byChannel, tokens)}`,
        ),
      );
    }
    return err(
      new Error(
        `Kein Abo postet in <#${channelId}>. Wähle ein Abo aus der Autovervollständigung oder nutze \`/setup subscription list\`, um den Code zu sehen.`,
      ),
    );
  }

  const byLabel = subs.value.filter((s) => s.label.toLowerCase() === normalized);
  if (byLabel.length === 1) return ok(byLabel[0]!);
  if (byLabel.length > 1) {
    const tokens = buildSubscriptionIdTokens(byLabel);
    return err(
      new Error(
        `Mehrere Abos heißen "${trimmed}". Bitte wähle ein Abo aus der Autovervollständigung oder nutze den Code:\n${formatSubscriptionList(byLabel, tokens)}`,
      ),
    );
  }

  const tokens = buildSubscriptionIdTokens(subs.value);
  return err(
    new Error(
      `Abo nicht gefunden. Wähle ein Abo aus der Autovervollständigung oder nutze \`/setup subscription list\`, um den Code zu sehen.\nVerfügbare Abos:\n${formatSubscriptionList(
        subs.value,
        tokens,
      )}\nTipp: Du kannst auch den Kanal erwähnen (z. B. #vinted-angebote).`,
    ),
  );
}
