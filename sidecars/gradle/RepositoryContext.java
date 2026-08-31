import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ProjectConnection;
import org.gradle.tooling.model.build.BuildEnvironment;
import org.gradle.tooling.model.GradleProject;
import org.gradle.tooling.model.GradleTask;
import org.gradle.tooling.model.idea.IdeaContentRoot;
import org.gradle.tooling.model.idea.IdeaDependency;
import org.gradle.tooling.model.idea.IdeaModule;
import org.gradle.tooling.model.idea.IdeaModuleDependency;
import org.gradle.tooling.model.idea.IdeaProject;
import org.gradle.tooling.model.idea.IdeaSourceDirectory;

/**
 * Read-only Gradle Tooling API exporter used by the repository-context plane.
 *
 * The caller opts in because loading a Gradle model evaluates project build
 * configuration. This helper never runs a task and reuses the wrapper-aware
 * Tooling API connection/daemon selected by Gradle itself.
 */
public final class RepositoryContext {
  public static void main(String[] args) {
    if (args.length != 1) {
      throw new IllegalArgumentException("usage: RepositoryContext.java <project>");
    }
    File root = new File(args[0]).getAbsoluteFile();
    GradleConnector connector =
        GradleConnector.newConnector().forProjectDirectory(root);
    try (ProjectConnection connection = connector.connect()) {
      BuildEnvironment environment = connection.getModel(BuildEnvironment.class);
      line("V", environment.getGradle().getGradleVersion());
      IdeaProject idea = connection.getModel(IdeaProject.class);
      List<? extends IdeaModule> modules = new ArrayList<>(idea.getModules());
      modules.sort(Comparator.comparing(module -> module.getGradleProject().getPath()));
      for (IdeaModule module : modules) {
        GradleProject project = module.getGradleProject();
        line("M", project.getPath(), module.getName(), project.getProjectDirectory().getPath());
        List<? extends GradleTask> tasks = new ArrayList<>(project.getTasks());
        tasks.sort(Comparator.comparing(GradleTask::getPath));
        for (GradleTask task : tasks) {
          line("T", project.getPath(), task.getPath(), task.getName());
        }
        for (IdeaContentRoot content : module.getContentRoots()) {
          source(project.getPath(), "source", content.getSourceDirectories());
          source(project.getPath(), "test", content.getTestDirectories());
          source(project.getPath(), "resource", content.getResourceDirectories());
          source(project.getPath(), "test-resource", content.getTestResourceDirectories());
        }
        List<? extends IdeaDependency> dependencies =
            new ArrayList<>(module.getDependencies());
        for (IdeaDependency dependency : dependencies) {
          if (dependency instanceof IdeaModuleDependency) {
            IdeaModuleDependency projectDependency = (IdeaModuleDependency) dependency;
            line("D", project.getPath(), projectDependency.getTargetModuleName());
          }
        }
      }
    }
  }

  private static void source(
      String project,
      String kind,
      Iterable<? extends IdeaSourceDirectory> directories) {
    List<IdeaSourceDirectory> sorted = new ArrayList<>();
    for (IdeaSourceDirectory directory : directories) {
      sorted.add(directory);
    }
    sorted.sort(Comparator.comparing(directory -> directory.getDirectory().getPath()));
    for (IdeaSourceDirectory directory : sorted) {
      line(
          "S",
          project,
          kind,
          directory.getDirectory().getPath(),
          Boolean.toString(directory.isGenerated()));
    }
  }

  private static void line(String kind, String... fields) {
    StringBuilder out = new StringBuilder(kind);
    for (String field : fields) {
      out.append('\t').append(
          Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(field.getBytes(StandardCharsets.UTF_8)));
    }
    System.out.println(out);
  }
}
