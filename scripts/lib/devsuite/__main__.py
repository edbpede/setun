"""`python -m devsuite` — the same entry point `scripts/devsuite` runs."""

import sys

from devsuite.cli import main

if __name__ == "__main__":
    sys.exit(main())
