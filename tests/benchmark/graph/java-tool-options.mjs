/**
 * Encode one JVM system property for JAVA_TOOL_OPTIONS.
 *
 * The JVM parses this variable itself, including its quote grammar. Keeping the
 * value quoted preserves legal benchmark output paths containing spaces for
 * both Maven-launched Java processes and direct launchers such as JDTLS.
 */
export function javaSystemProperty(name, value) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new TypeError(`invalid Java system property name: ${name}`);
  }
  return `-D${name}="${value.replaceAll('"', '\\"')}"`;
}
