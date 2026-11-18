import * as json from './json.ts';
import * as binary from './binary.ts';
import type { Codec, CodecName } from '../protocol.ts';

export const codecs: Record<CodecName, Codec> = { json: json.codec, binary: binary.codec };
export const getCodec = (name: string): Codec | null => (name === 'json' || name === 'binary' ? codecs[name] : null);
