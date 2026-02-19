import type { Guild, User } from 'discord.js';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { err, ok, type Result } from 'neverthrow';

type CreatePrivateTextChannelForUserInput = {
  guild: Guild;
  owner: User;
  nameHint: string;
};

function slugifyChannelName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

export async function createPrivateTextChannelForUser(
  input: CreatePrivateTextChannelForUserInput,
): Promise<Result<{ id: string }, Error>> {
  const { guild, owner, nameHint } = input;

  const categoryName = `vinted-${owner.id}`;
  const existingCategory = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name === categoryName,
  );

  const category =
    existingCategory ??
    (await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: owner.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ],
    }));

  const channelName = slugifyChannelName(nameHint || 'deals');
  if (!channelName) {
    return err(new Error('Ungültiger Kanalname.'));
  }

  const botUserId = guild.members.me?.id ?? guild.client.user.id;

  const created = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: owner.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: botUserId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
    ],
  });

  return ok({ id: created.id });
}
