// ini 5 does not publish declarations. Describe only the parse/stringify
// operations used for legacy credential migration in this package.
declare module "ini" {
  const ini: {
    parse(text: string): Record<string, unknown>;
    stringify(value: Record<string, unknown>): string;
  };
  export default ini;
}
