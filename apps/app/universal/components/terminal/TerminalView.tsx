/**
 * Platform dispatcher for the terminal surface.
 *
 * Mirrors ``WorkflowEditor.tsx``: an explicit dispatcher guarantees the
 * right variant loads on each target (Metro's automatic ``.web``/
 * ``.native`` resolution is unreliable for nested component paths). The
 * web variant is a full xterm.js terminal; the native variant is a
 * line-mode fallback. xterm itself is dynamically imported inside the
 * web variant's effect, so it never evaluates on native even though this
 * dispatcher references the module statically.
 */

import { Platform } from 'react-native';

import TerminalViewNative from './TerminalView.native';
import TerminalViewWeb from './TerminalView.web';

const TerminalView = Platform.OS === 'web' ? TerminalViewWeb : TerminalViewNative;

export default TerminalView;
export type { TerminalViewProps, TerminalStatus } from './types';
