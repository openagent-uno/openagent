/** Device inventory is descriptive; only server-issued tool references authorize use. */
export interface ConnectedDevice {
  device_id: string;
  client_instance_id: string;
  label: string;
  online: boolean;
  modules: string[];
  last_seen_at: number;
}
export interface SessionDevice {
  device_id: string;
  client_instance_id: string;
  label: string;
  first_used_at: number;
  last_used_at: number;
}
export interface AgentComputer {
  label: string;
  platform: string;
  desktop: 'available' | 'unavailable' | 'restricted';
}
export interface ComputerTarget {
  tool_ref: string;
  label: string;
  live_media?: string | null;
  agent_host?: boolean;
  can_control?: boolean;
}
export type ComputerAction = 'get_screenshot' | 'mouse_move' | 'middle_click' | 'left_click' | 'double_click' | 'right_click' | 'left_click_drag' | 'scroll' | 'key' | 'type';
export interface ComputerFrame { uri: string; width: number; height: number; input_width?: number; input_height?: number }

export function computerFrame(result: unknown): ComputerFrame | null {
  const value = result as { content?: { type: string; data?: string; mimeType?: string; text?: string }[]; isError?: boolean };
  if (value?.isError) throw new Error(value.content?.find(c => c.type === 'text')?.text || 'Computer action failed');
  const image = value?.content?.find(c => c.type === 'image' && ['image/png', 'image/jpeg'].includes(c.mimeType || ''));
  if (!image?.data) return null;
  for (const block of value.content || []) {
    if (block.type !== 'text' || !block.text) continue;
    try {
      const meta = JSON.parse(block.text);
      if (Number.isFinite(meta.image_width) && Number.isFinite(meta.image_height)
        && meta.image_width > 0 && meta.image_height > 0 && meta.image_width <= 32768 && meta.image_height <= 32768) {
        return { uri: `data:${image.mimeType};base64,${image.data}`, width: meta.image_width, height: meta.image_height };
      }
    } catch { /* Another tool text block. */ }
  }
  throw new Error('This computer did not return screen dimensions. Update its computer tools.');
}

export function screenCoordinate(x: number, y: number, displayedWidth: number, frame: ComputerFrame): [number, number] {
  const scale = (frame.input_width || frame.width) / displayedWidth;
  const scaleY = (frame.input_height || frame.height) / (displayedWidth * frame.height / frame.width);
  return [Math.max(0, Math.min((frame.input_width || frame.width) - 1, Math.floor(x * scale))),
    Math.max(0, Math.min((frame.input_height || frame.height) - 1, Math.floor(y * scaleY)))];
}
