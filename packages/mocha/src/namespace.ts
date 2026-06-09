import type { MessageId, TrackType } from './types.js';

export interface TrackRef {
  namespace: string[];
  trackName: string;
}

export class MochaNamespace {
  constructor(
    readonly realm: string,
    readonly path: string[],
    readonly channel: string,
  ) {}

  static forChannel(realm: string, path: string[], channel: string): MochaNamespace {
    return new MochaNamespace(realm, path, channel);
  }

  private ns(trackType: TrackType): string[] {
    return ['mocha', this.realm, ...this.path, this.channel, trackType];
  }

  messages(): TrackRef {
    return { namespace: this.ns('messages'), trackName: 'live' };
  }

  history(): TrackRef {
    return { namespace: this.ns('history'), trackName: 'archive' };
  }

  meta(): TrackRef {
    return { namespace: this.ns('meta'), trackName: 'info' };
  }

  roster(): TrackRef {
    return { namespace: this.ns('roster'), trackName: 'members' };
  }

  presence(): TrackRef {
    return { namespace: this.ns('presence'), trackName: 'roster' };
  }

  typing(): TrackRef {
    return { namespace: this.ns('typing'), trackName: 'indicators' };
  }

  receipts(): TrackRef {
    return { namespace: this.ns('receipts'), trackName: 'live' };
  }

  threads(): TrackRef {
    return { namespace: this.ns('threads'), trackName: 'index' };
  }

  thread(messageId: MessageId): TrackRef {
    return {
      namespace: this.ns('messages'),
      trackName: `thread/${messageId.group}-${messageId.object}`,
    };
  }

  moderation(): TrackRef {
    return { namespace: this.ns('moderation'), trackName: 'actions' };
  }

  media(userId: string): TrackRef {
    return {
      namespace: [...this.ns('media'), userId],
      trackName: 'video',
    };
  }

  channelPrefix(): string[] {
    return ['mocha', this.realm, ...this.path, this.channel];
  }

  get id(): string {
    return [...this.path, this.channel].join('/');
  }

  static parse(namespace: string[]): { realm: string; path: string[]; channel: string; trackType: TrackType } | null {
    if (namespace.length < 4 || namespace[0] !== 'mocha') return null;
    const realm = namespace[1];
    const trackType = namespace[namespace.length - 1] as TrackType;
    const channel = namespace[namespace.length - 2];
    const path = namespace.slice(2, namespace.length - 2);
    return { realm, path, channel, trackType };
  }
}
