/**
 * Properties editor for the ``trigger-schedule`` block.
 *
 * Wraps the shared ``CronPicker`` so the same preset + preview UX
 * shows up here and on the workflow-list create form. Editing the
 * cron on this block flushes to the gateway when the user hits Save;
 * the backend's ``derive_schedule_updates`` helper then syncs the
 * row-level ``cron_expression`` + ``next_run_at`` so the scheduler
 * loop picks the workflow up without a separate field.
 */

import { View } from 'react-native';
import CronPicker from '../../CronPicker';
import type { WorkflowNode } from '../../../../common/types';

interface Props {
  node: WorkflowNode;
  onChange: (patch: Partial<WorkflowNode>) => void;
}

export default function TriggerScheduleProperties({ node, onChange }: Props) {
  const config = (node.config || {}) as Record<string, any>;

  const setCron = (expression: string) => {
    onChange({ config: { ...config, cron_expression: expression } });
  };

  return (
    <View nativeID="workflow-field-cron_expression">
      <CronPicker
        label="Cron expression"
        value={(config.cron_expression as string) || ''}
        onChange={setCron}
      />
    </View>
  );
}
