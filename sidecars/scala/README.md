# Scala graph producer

This Maven reactor builds the `samchon-scala-graph` BSP client and the paired
Scala 2.13.18 and Scala 3.9.0 compiler plugins shipped with `@samchon/graph`.
Build all three artifacts with JDK 17 or newer:

```bash
mvn --batch-mode --file sidecars/scala/pom.xml verify
```

The build writes these runnable artifacts:

- `scala2-plugin/target/scala-graph-plugin_2.13.18-0.1.0-SNAPSHOT.jar`
- `scala3-plugin/target/scala-graph-plugin_3.9.0-0.1.0-SNAPSHOT.jar`
- `server/target/samchon-scala-graph-0.1.0-SNAPSHOT.jar`

Expose the server jar through a `samchon-scala-graph` launcher that executes
`java -jar`, or point `SAMCHON_GRAPH_SCALA_GRAPH` at such a launcher. The
indexed repository must contain exactly one usable `.bsp/*.json` connection.

Each non-empty Scala BSP target must load the matching typed plugin with
`-Xplugin`, pass the plugin's `root`, `output`, `target`, and `version` options,
and emit SemanticDB during the same compile. Scala 2 also needs SemanticDB's
source root, target root, build target, md5, symbols, and diagnostics options;
Scala 3 needs `-Xsemanticdb` and `-sourceroot`. The plugin `target` value and
SemanticDB build target must equal the target URI returned by BSP.

The pinned [Scala experiment fixture](https://github.com/samchon/graph-benchmark-scala)
contains a complete sbt configuration for both compiler lines. Generate its
BSP connection with `sbt bspConfig`; graph refreshes then ask that BSP server
for ordinary incremental compilation and never run `clean`.
