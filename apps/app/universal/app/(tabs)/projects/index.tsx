import { ProjectList, useProjectSource } from '../../../components/ProjectTasks';

export default function ProjectsScreen() {
  return <ProjectList key={useProjectSource()} />;
}
