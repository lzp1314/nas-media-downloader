import { loadSettings } from '../settings.js';
import { aria2Engine } from './aria2.js';
import { qbitEngine } from './qbit.js';

export function currentEngine() {
  return loadSettings().engine === 'qbit' ? qbitEngine : aria2Engine;
}

export function engineByName(name) {
  return name === 'qbit' ? qbitEngine : aria2Engine;
}

export { aria2Engine, qbitEngine };
