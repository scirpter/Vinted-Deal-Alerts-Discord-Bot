import { beforeEach, describe, expect, it, vi } from 'vitest';

const hourMs = 60 * 60 * 1000;

describe('setup-required-notifier', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('sends channel and DM once within cooldown window', async () => {
    const { notifySetupRequiredIfNeeded } = await import('../services/setup-required-notifier.js');

    const channelSend = vi.fn().mockResolvedValue(undefined);
    const dmSend = vi.fn().mockResolvedValue(undefined);

    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({ send: channelSend }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: dmSend }) },
    };

    const subscription = {
      id: 'sub-1',
      discordUserId: 'user-1',
      discordChannelId: 'channel-1',
    };

    await notifySetupRequiredIfNeeded({ client, subscription, now: 1_000 });
    await notifySetupRequiredIfNeeded({ client, subscription, now: 1_000 + hourMs - 1 });

    expect(channelSend).toHaveBeenCalledTimes(1);
    expect(dmSend).toHaveBeenCalledTimes(1);
  });

  it('calls unknown-channel handler and still sends DM', async () => {
    const { notifySetupRequiredIfNeeded } = await import('../services/setup-required-notifier.js');

    const onUnknownChannel = vi.fn().mockResolvedValue(undefined);
    const dmSend = vi.fn().mockResolvedValue(undefined);

    const client = {
      channels: { fetch: vi.fn().mockRejectedValue({ code: 10003 }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: dmSend }) },
    };

    const subscription = {
      id: 'sub-2',
      discordUserId: 'user-2',
      discordChannelId: 'channel-2',
    };

    await notifySetupRequiredIfNeeded({
      client,
      subscription,
      now: 2_000,
      onUnknownChannel,
    });

    expect(onUnknownChannel).toHaveBeenCalledTimes(1);
    expect(dmSend).toHaveBeenCalledTimes(1);
  });

  it('swallows cannot-DM-user errors', async () => {
    const { notifySetupRequiredIfNeeded } = await import('../services/setup-required-notifier.js');

    const channelSend = vi.fn().mockResolvedValue(undefined);
    const dmSend = vi.fn().mockRejectedValue({ code: 50007 });

    const client = {
      channels: { fetch: vi.fn().mockResolvedValue({ send: channelSend }) },
      users: { fetch: vi.fn().mockResolvedValue({ send: dmSend }) },
    };

    const subscription = {
      id: 'sub-3',
      discordUserId: 'user-3',
      discordChannelId: 'channel-3',
    };

    await expect(
      notifySetupRequiredIfNeeded({
        client,
        subscription,
        now: 3_000,
      }),
    ).resolves.toBeUndefined();

    expect(channelSend).toHaveBeenCalledTimes(1);
    expect(dmSend).toHaveBeenCalledTimes(1);
  });
});
