"""One killable Docling job. Only the shared Parser starts this helper."""
import sys

def main():
    import resource
    from pathlib import Path
    from env_config import env_int
    limit = env_int("PARSER_MAX_RETAINED_BYTES", 200 * 1024 * 1024)
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
    import torch
    try:
        compat = torch.library.Library("torchvision", "DEF")
    except RuntimeError:
        compat = torch.library.Library("torchvision", "FRAGMENT")
    for operator in ("nms", "qnms"):
        try:
            compat.define(f"{operator}(Tensor boxes, Tensor scores, float iou_threshold) -> Tensor")
        except RuntimeError:
            pass
    from docling.document_converter import DocumentConverter
    result = DocumentConverter().convert(sys.argv[1])
    # Large model logs go to stderr; stdout is exclusively the artifact.
    from pathlib import Path
    markdown = result.document.export_to_markdown()
    if len(markdown.encode("utf-8")) > limit:
        raise RuntimeError("Docling artifact exceeds budget")
    Path(sys.argv[2]).write_text(markdown, encoding="utf-8")

if __name__ == "__main__":
    main()
