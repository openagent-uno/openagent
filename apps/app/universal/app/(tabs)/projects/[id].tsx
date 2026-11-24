import { useLocalSearchParams } from 'expo-router';
import { ProjectDetail, useProjectSource } from '../../../components/ProjectTasks';

export default function ProjectTaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ProjectDetail key={useProjectSource() + id} id={id} />;
}
