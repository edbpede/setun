"""`resume` and `destroy` — the two commands that address an instance by name."""

import shutil
import subprocess

from devsuite.commands.lifecycle import command_start, command_stop
from devsuite.compose import compose_argv, compose_command
from devsuite.console import confirm, fail, note
from devsuite.instance import instance_for, instance_is_running, reap_stale
from devsuite.layout import REPO
from devsuite.options import Options
from devsuite.util import directory_size


def command_resume(options: Options) -> int:
    instance = instance_for(options.name, "persistent")
    if not instance.root.exists():
        fail(
            f"no saved instance named '{options.name}'",
            hint="`./scripts/devsuite list` shows what there is.",
        )
    options.persistent = options.name
    options.ephemeral = False
    return command_start(options)


def command_destroy(options: Options) -> int:
    instance = instance_for(options.name, "persistent")
    if not instance.root.exists():
        note(f"no instance named '{options.name}'")
        return 0

    size = directory_size(instance.data)
    if not confirm(
        f"Permanently delete instance '{options.name}' and its {size} of data?", options.force
    ):
        note("cancelled")
        return 1

    if instance_is_running(instance):
        note("instance is running — stopping it first")
        options.persistent = options.name
        options.ephemeral = False
        _ = command_stop(options)

    reap_stale(instance, announce=False)

    if compose_command():
        _ = subprocess.run(
            compose_argv(instance.compose_project, "down", "--volumes"),
            cwd=REPO,
            capture_output=True,
            text=True,
            check=False,
        )

    shutil.rmtree(instance.root, ignore_errors=True)
    note(f"destroyed '{options.name}'")
    return 0
