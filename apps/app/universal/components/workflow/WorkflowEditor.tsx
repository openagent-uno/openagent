/**
 * Platform dispatcher for the Workflow editor.
 *
 * Metro's automatic ``.web.tsx`` / ``.native.tsx`` resolution does
 * not always kick in for nested component paths — keeping an explicit
 * dispatcher file guarantees the right variant loads on each target.
 * The web variant pulls in React Flow (DOM-only); the native variant
 * is a touch-first editor backed by an SVG canvas (Phase 7 shipped).
 * Both expose the same metadata controls — concurrency cap, history
 * drawer, save/run — so behaviour stays consistent across surfaces.
 */

import { Platform } from 'react-native';

import WorkflowEditorNative from './WorkflowEditor.native';
import WorkflowEditorWeb from './WorkflowEditor.web';

const WorkflowEditor =
  Platform.OS === 'web' ? WorkflowEditorWeb : WorkflowEditorNative;

export default WorkflowEditor;
