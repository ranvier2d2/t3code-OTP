defmodule Harness.ImageProcessor do
  @moduledoc """
  Stateless image processing utilities for provider sessions.

  Validates, parses, and converts image attachments from the frontend
  `ChatImageAttachment` format into provider-specific wire formats.

  Each provider has a fundamentally different wire format:

  | Provider   | Image Wire Format                                          |
  |------------|------------------------------------------------------------|
  | Codex      | `%{"type" => "image", "image_url" => "data:..."}` in input |
  | OpenCode   | `%{"type" => "image_url", "url" => "data:..."}` in parts   |

  This is a pure module (not a GenServer) because image processing is
  stateless and CPU-bound. Each session GenServer calls these functions
  synchronously. If processing crashes, the session GenServer crashes
  and is handled by DynamicSupervisor — "let it crash".
  """

  require Logger

  # Match frontend limit from contracts: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
  @max_image_bytes 10 * 1024 * 1024

  @allowed_mime_types ~w(image/png image/jpeg image/gif image/webp)

  @type parsed_image :: %{
          mime_type: String.t(),
          base64_data: String.t(),
          data_url: String.t(),
          size_bytes: non_neg_integer(),
          name: String.t()
        }

  @doc """
  Parse and validate a list of attachment maps from the frontend.

  Filters to image-type attachments only, validates each one, and returns
  a list of parsed image structs ready for provider-specific conversion.

  ## Examples

      iex> attachments = [%{"type" => "image", "name" => "screenshot.png",
      ...>   "mimeType" => "image/png", "sizeBytes" => 1024,
      ...>   "dataUrl" => "data:image/png;base64,iVBOR..."}]
      iex> {:ok, [%{mime_type: "image/png", name: "screenshot.png"}]} =
      ...>   Harness.ImageProcessor.parse_attachments(attachments)

  """
  @spec parse_attachments(list(map())) :: {:ok, list(parsed_image())} | {:error, term()}
  def parse_attachments(attachments) when is_list(attachments) do
    images =
      attachments
      |> Enum.filter(&image_attachment?/1)
      |> Enum.reduce_while([], fn attachment, acc ->
        case parse_single(attachment) do
          {:ok, image} -> {:cont, [image | acc]}
          {:error, reason} -> {:halt, {:error, reason}}
        end
      end)

    case images do
      {:error, _} = err -> err
      list when is_list(list) -> {:ok, Enum.reverse(list)}
    end
  end

  def parse_attachments(_), do: {:ok, []}

  @doc """
  Convert a parsed image to Codex input format.

  Codex uses OpenAI's Responses API which expects images as data URLs
  in the input array alongside text items.

  Returns `%{"type" => "image", "image_url" => "data:image/png;base64,..."}`.
  """
  @spec to_codex_input(parsed_image()) :: map()
  def to_codex_input(%{data_url: data_url}) do
    %{"type" => "image", "image_url" => data_url}
  end

  @doc """
  Convert a parsed image to OpenCode parts format.

  OpenCode accepts image parts in its `prompt_async` endpoint.
  The format uses `image_url` type with the full data URL, which
  OpenCode internally routes to the appropriate provider format
  (Anthropic, OpenAI, Gemini).

  Returns `%{"type" => "image_url", "url" => "data:image/png;base64,..."}`.
  """
  @spec to_opencode_part(parsed_image()) :: map()
  def to_opencode_part(%{data_url: data_url}) do
    %{"type" => "image_url", "url" => data_url}
  end

  # --- Internal ---

  defp image_attachment?(%{"type" => "image"}), do: true
  defp image_attachment?(_), do: false

  defp parse_single(attachment) do
    with {:ok, data_url} <- extract_data_url(attachment),
         {:ok, mime_type, base64_data} <- parse_data_url(data_url),
         :ok <- validate_mime_type(mime_type),
         :ok <- validate_size(attachment) do
      {:ok,
       %{
         mime_type: mime_type,
         base64_data: base64_data,
         data_url: data_url,
         size_bytes: Map.get(attachment, "sizeBytes"),
         name: Map.get(attachment, "name", "unnamed")
       }}
    end
  end

  defp extract_data_url(%{"dataUrl" => data_url}) when is_binary(data_url) and data_url != "" do
    {:ok, data_url}
  end

  defp extract_data_url(_), do: {:error, :missing_data_url}

  defp parse_data_url("data:" <> rest) do
    case String.split(rest, ";base64,", parts: 2) do
      [mime_type, base64_data] when mime_type != "" and base64_data != "" ->
        {:ok, mime_type, base64_data}

      _ ->
        {:error, :invalid_data_url_format}
    end
  end

  defp parse_data_url(_), do: {:error, :invalid_data_url_format}

  defp validate_mime_type(mime_type) do
    if mime_type in @allowed_mime_types do
      :ok
    else
      {:error, {:unsupported_mime_type, mime_type}}
    end
  end

  defp validate_size(%{"sizeBytes" => size}) when is_integer(size) and size > @max_image_bytes do
    {:error, {:image_too_large, size, @max_image_bytes}}
  end

  defp validate_size(%{"sizeBytes" => size}) when is_integer(size) and size >= 0 do
    :ok
  end

  defp validate_size(_), do: {:error, :invalid_size_bytes}
end
