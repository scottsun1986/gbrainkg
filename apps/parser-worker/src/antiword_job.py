"""Apply byte limits before replacing this isolated child with antiword."""
import os
import resource
import sys

limit = int(sys.argv[3])
resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
os.execvp(sys.argv[1], [sys.argv[1], "-f", sys.argv[2]])
