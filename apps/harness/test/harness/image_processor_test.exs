defmodule Harness.ImageProcessorTest do
  use ExUnit.Case, async: true

  alias Harness.ImageProcessor

  @valid_png_data_url "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  @valid_jpeg_data_url "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
  @valid_gif_data_url "data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP8AACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=="
  @valid_webp_data_url "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"

  defp make_attachment(overrides \\ %{}) do
    Map.merge(
      %{
        "type" => "image",
        "id" => "img-001",
        "name" => "screenshot.png",
        "mimeType" => "image/png",
        "sizeBytes" => 1024,
        "dataUrl" => @valid_png_data_url
      },
      overrides
    )
  end

  # --- parse_attachments/1 ---

  describe "parse_attachments/1" do
    test "parses a single valid image attachment" do
      assert {:ok, [image]} = ImageProcessor.parse_attachments([make_attachment()])
      assert image.mime_type == "image/png"
      assert image.name == "screenshot.png"
      assert image.size_bytes == 1024
      assert is_binary(image.base64_data)
      assert String.starts_with?(image.data_url, "data:image/png;base64,")
    end

    test "parses multiple valid attachments" do
      attachments = [
        make_attachment(%{"name" => "a.png"}),
        make_attachment(%{
          "name" => "b.jpg",
          "mimeType" => "image/jpeg",
          "dataUrl" => @valid_jpeg_data_url
        })
      ]

      assert {:ok, images} = ImageProcessor.parse_attachments(attachments)
      assert length(images) == 2
      assert Enum.at(images, 0).name == "a.png"
      assert Enum.at(images, 1).name == "b.jpg"
    end

    test "supports all allowed MIME types" do
      for {mime, url} <- [
            {"image/png", @valid_png_data_url},
            {"image/jpeg", @valid_jpeg_data_url},
            {"image/gif", @valid_gif_data_url},
            {"image/webp", @valid_webp_data_url}
          ] do
        attachment = make_attachment(%{"mimeType" => mime, "dataUrl" => url})
        assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
        assert image.mime_type == mime
      end
    end

    test "filters out non-image attachments" do
      text_attachment = %{"type" => "text", "content" => "hello"}
      image_attachment = make_attachment()

      assert {:ok, [image]} =
               ImageProcessor.parse_attachments([text_attachment, image_attachment])

      assert image.name == "screenshot.png"
    end

    test "returns empty list for no attachments" do
      assert {:ok, []} = ImageProcessor.parse_attachments([])
    end

    test "returns empty list for nil input" do
      assert {:ok, []} = ImageProcessor.parse_attachments(nil)
    end

    test "returns empty list when all attachments are non-image" do
      assert {:ok, []} =
               ImageProcessor.parse_attachments([%{"type" => "text", "content" => "hello"}])
    end

    test "rejects attachment with missing dataUrl" do
      attachment = make_attachment() |> Map.delete("dataUrl")
      assert {:error, :missing_data_url} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects attachment with empty dataUrl" do
      attachment = make_attachment(%{"dataUrl" => ""})
      assert {:error, :missing_data_url} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects attachment with invalid data URL format" do
      attachment = make_attachment(%{"dataUrl" => "not-a-data-url"})
      assert {:error, :invalid_data_url_format} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects attachment with data URL missing base64 marker" do
      attachment = make_attachment(%{"dataUrl" => "data:image/png,rawdata"})
      assert {:error, :invalid_data_url_format} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects unsupported MIME type" do
      attachment =
        make_attachment(%{
          "mimeType" => "image/bmp",
          "dataUrl" => "data:image/bmp;base64,Qk0="
        })

      assert {:error, {:unsupported_mime_type, "image/bmp"}} =
               ImageProcessor.parse_attachments([attachment])
    end

    test "rejects image exceeding max size" do
      max_bytes = 10 * 1024 * 1024
      attachment = make_attachment(%{"sizeBytes" => max_bytes + 1})

      assert {:error, {:image_too_large, _, ^max_bytes}} =
               ImageProcessor.parse_attachments([attachment])
    end

    test "accepts image at exactly max size" do
      max_bytes = 10 * 1024 * 1024
      attachment = make_attachment(%{"sizeBytes" => max_bytes})
      assert {:ok, [_]} = ImageProcessor.parse_attachments([attachment])
    end

    test "stops at first error in list" do
      bad = make_attachment(%{"dataUrl" => "bad"})
      good = make_attachment()

      assert {:error, :invalid_data_url_format} =
               ImageProcessor.parse_attachments([bad, good])
    end

    test "rejects attachment with missing sizeBytes" do
      attachment = make_attachment() |> Map.delete("sizeBytes")
      assert {:error, :invalid_size_bytes} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects attachment with non-integer sizeBytes" do
      attachment = make_attachment(%{"sizeBytes" => "1024"})
      assert {:error, :invalid_size_bytes} = ImageProcessor.parse_attachments([attachment])
    end

    test "rejects attachment with negative sizeBytes" do
      attachment = make_attachment(%{"sizeBytes" => -1})
      assert {:error, :invalid_size_bytes} = ImageProcessor.parse_attachments([attachment])
    end

    test "accepts attachment with sizeBytes of 0" do
      attachment = make_attachment(%{"sizeBytes" => 0})
      assert {:ok, [image]} = ImageProcessor.parse_attachments([attachment])
      assert image.size_bytes == 0
    end
  end

  # --- to_codex_input/1 ---

  describe "to_codex_input/1" do
    test "produces Codex image input format" do
      {:ok, [image]} = ImageProcessor.parse_attachments([make_attachment()])
      result = ImageProcessor.to_codex_input(image)

      assert result == %{
               "type" => "image",
               "image_url" => @valid_png_data_url
             }
    end
  end

  # --- to_opencode_part/1 ---

  describe "to_opencode_part/1" do
    test "produces OpenCode image part format" do
      {:ok, [image]} = ImageProcessor.parse_attachments([make_attachment()])
      result = ImageProcessor.to_opencode_part(image)

      assert result == %{
               "type" => "image_url",
               "url" => @valid_png_data_url
             }
    end
  end
end
