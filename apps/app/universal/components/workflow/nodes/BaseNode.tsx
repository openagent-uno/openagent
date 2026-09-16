/**
 * BaseNode — shared visual shell for every custom React Flow node.
 *
 * Renders: icon + type badge on top row, label (editable-on-double-click
 * eventually — for now static), small preview line per block type,
 * status dot (idle / running / success / failed) using theme colors,
 * plus the configurable input/output handles.
 *
 * Each block-type node composes BaseNode and passes its own icon,
 * preview renderer, and handle layout.
 */

import Feather from '@expo/vector-icons/Feather';
import { Handle, Position } from 'reactflow';
import { memo } from 'react';
import { colors, font, radius } from '../../../theme';

export interface BaseNodeProps {
  icon: any; // Feather icon name
  typeLabel: string;
  label?: string;
  preview?: string;
  status?: 'idle' | 'running' | 'success' | 'failed';
  selected?: boolean;
  sourceHandles?: string[]; // default ['out']
  targetHandles?: string[]; // default ['in']
  handleLabels?: Record<string, string>;
  width?: number;
}

const STATUS_COLOR: Record<NonNullable<BaseNodeProps['status']>, string> = {
  idle: 'transparent',
  running: '#CC8020',
  success: '#15885E',
  failed: '#C94A43',
};

export const BaseNode = memo(function BaseNode({
  icon,
  typeLabel,
  label,
  preview,
  status = 'idle',
  selected,
  sourceHandles = ['out'],
  targetHandles = ['in'],
  handleLabels = {},
  width = 220,
}: BaseNodeProps) {
  const statusColor = STATUS_COLOR[status];

  return (
    <div
      style={{
        width,
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        border: `1.5px solid ${selected ? colors.primary : colors.border}`,
        boxShadow: selected
          ? '0 0 0 3px rgba(217, 72, 65, 0.18)'
          : '0 1px 2px rgba(26, 25, 21, 0.05)',
        fontFamily: font.sans,
        overflow: 'visible',
      }}
    >
      {targetHandles.map((h, i) => (
        <Handle
          key={`t-${h}`}
          id={h}
          type="target"
          position={Position.Left}
          style={{
            top: `${((i + 1) / (targetHandles.length + 1)) * 100}%`,
            width: 10,
            height: 10,
            background: colors.surface,
            border: `2px solid ${colors.border}`,
          }}
        />
      ))}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 10px',
          borderBottom: `1px solid ${colors.borderLight}`,
          gap: 6,
        }}
      >
        <Feather name={icon} size={12} color={colors.primary} />
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: colors.primary,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          {typeLabel}
        </span>
        {status !== 'idle' && (
          <span
            style={{
              marginLeft: 'auto',
              width: 7,
              height: 7,
              borderRadius: 7,
              background: statusColor,
              boxShadow: `0 0 6px ${statusColor}`,
            }}
          />
        )}
      </div>

      <div style={{ padding: '8px 10px' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: colors.text,
            letterSpacing: -0.1,
            marginBottom: preview ? 2 : 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label || typeLabel}
        </div>
        {preview && (
          <div
            style={{
              fontSize: 11,
              color: colors.textSecondary,
              lineHeight: '15px',
              maxHeight: 30,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical' as any,
              fontFamily: font.mono,
            }}
          >
            {preview}
          </div>
        )}
      </div>

      {sourceHandles.map((h, i) => (
        <div key={`s-${h}-wrap`}>
          <Handle
            id={h}
            type="source"
            position={Position.Right}
            style={{
              top: `${((i + 1) / (sourceHandles.length + 1)) * 100}%`,
              width: 10,
              height: 10,
              background: colors.surface,
              border: `2px solid ${colors.primary}`,
            }}
          />
          {handleLabels[h] && (
            <span
              style={{
                position: 'absolute',
                right: -8,
                top: `calc(${((i + 1) / (sourceHandles.length + 1)) * 100}% - 18px)`,
                fontSize: 9,
                color: colors.textMuted,
                background: colors.bg,
                padding: '1px 4px',
                borderRadius: radius.xs,
                pointerEvents: 'none',
              }}
            >
              {handleLabels[h]}
            </span>
          )}
        </div>
      ))}
    </div>
  );
});
