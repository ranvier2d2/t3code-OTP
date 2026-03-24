import Config

# Read harness port from environment, default 4321
harness_port = String.to_integer(System.get_env("T3CODE_HARNESS_PORT", "4321"))
harness_secret = System.get_env("T3CODE_HARNESS_SECRET", "dev-harness-secret")

config :harness,
  harness_secret: harness_secret

config :harness, HarnessWeb.Endpoint,
  http: [port: harness_port],
  server: true

if config_env() == :prod do
  trimmed_secret = String.trim(harness_secret || "")

  if trimmed_secret == "" or trimmed_secret == "dev-harness-secret" do
    raise "T3CODE_HARNESS_SECRET must be set to a non-default, non-empty value in production"
  end

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise "environment variable SECRET_KEY_BASE is missing"

  config :harness, HarnessWeb.Endpoint,
    http: [ip: {127, 0, 0, 1}, port: harness_port],
    secret_key_base: secret_key_base
end
