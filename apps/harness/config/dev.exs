import Config

config :harness, HarnessWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}],
  check_origin: false,
  debug_errors: true,
  secret_key_base: "etLgV+eZi0kOJwHQ9iO49gVcLJXGPu5FRB2MG+53NEd9BVGj8JrAbG9k4cWUbwIZ",
  server: true

config :logger, :default_formatter, format: "[$level] $message\n"
config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime
