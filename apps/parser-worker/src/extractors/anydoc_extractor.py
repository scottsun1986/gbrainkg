import logging
from pathlib import Path

logger = logging.getLogger(__name__)

def extract_with_anydoc(path: Path) -> str:
    """Disabled AnyDoc CLI extraction path.
    
    AnyDoc extraction has been converged to the Node.js API side (via @firecrawl/anydoc)
    to avoid duplicate parsing and ensure consistent container capabilities.
    If you reach this point, you should use the API-side AnyDoc path instead.
    """
    raise RuntimeError(
        "AnyDoc parsing is natively handled by the API (Node.js). "
        "The parser worker is reserved for OCR, antiword, and layout fallbacks. "
        "Please route AnyDoc-capable formats through the API first."
    )
