import * as json from './json.js';
import * as binary from './binary.js';

export const codecs = { json, binary };
export const getCodec = (name) => codecs[name] ?? null;
