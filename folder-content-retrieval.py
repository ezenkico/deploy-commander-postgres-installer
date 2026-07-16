from pathlib import Path
from datetime import datetime

# Hard-coded input folder.
# Change this to the service folder you want to capture.
SOURCE_FOLDER = Path("")

# Hard-coded output folder.
# Change this to wherever you want the generated file placed.
OUTPUT_FOLDER = Path("./tmp")

# Name of the output file.
OUTPUT_FILE_NAME = "folder-dump.txt"


def should_include_file(path: Path) -> bool:
    """
    Returns true if this file should be included in the dump.
    Adjust this if you want to skip generated files, test files, etc.
    """
    if not path.is_file():
        return False

    # Skip hidden files like .DS_Store or .env.
    if path.name.startswith("."):
        return False

    return True


def main() -> None:
    if not SOURCE_FOLDER.exists():
        raise FileNotFoundError(f"Source folder does not exist: {SOURCE_FOLDER}")

    if not SOURCE_FOLDER.is_dir():
        raise NotADirectoryError(f"Source path is not a folder: {SOURCE_FOLDER}")

    OUTPUT_FOLDER.mkdir(parents=True, exist_ok=True)

    output_path = OUTPUT_FOLDER / OUTPUT_FILE_NAME

    files = sorted(
        path for path in SOURCE_FOLDER.iterdir()
        if should_include_file(path)
    )

    with output_path.open("w", encoding="utf-8") as out:
        out.write(f"Service folder dump\n")
        out.write(f"Source folder: {SOURCE_FOLDER}\n")
        out.write(f"Generated at: {datetime.now().isoformat(timespec='seconds')}\n")
        out.write("\n")

        for file_path in files:
            out.write("=" * 80)
            out.write("\n")
            out.write(f"FILE: {file_path.name}\n")
            out.write("=" * 80)
            out.write("\n\n")

            try:
                contents = file_path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                out.write("[Skipped: file is not valid UTF-8 text]\n\n")
                continue

            out.write(contents)

            if not contents.endswith("\n"):
                out.write("\n")

            out.write("\n\n")

    print(f"Wrote {len(files)} files to: {output_path}")


if __name__ == "__main__":
    main()