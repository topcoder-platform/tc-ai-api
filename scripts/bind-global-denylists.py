#!/usr/bin/env python3
"""Bind denylist names to global SSM parameters without changing other precedence."""
from pathlib import Path
import sys


def bind_global_denylists(source: str) -> str:
    marker = "psenvaddition() {"
    start = source.index(marker)
    end = source.index("\n}", start)
    function = source[start:end]
    assignment = "    envvalue=$2"
    if function.count(assignment) != 1:
        raise ValueError("Unsupported deployment suite: expected one secret assignment")
    replacement = assignment + '''
    case "$envname" in
        ACCESS_CONTROL_BLOCKED_SUBJECTS|ACCESS_CONTROL_BLOCKED_USER_IDS)
            envvalue="arn:aws:ssm:$AWS_REGION:$AWS_ACCOUNT_ID:parameter/config/common/global-appvar/$envname"
            ;;
    esac'''
    source = source[:start] + function.replace(assignment, replacement) + source[end:]
    marker = '    log "Environment has updated"'
    if source.count(marker) != 1:
        raise ValueError("Unsupported deployment suite: expected one environment boundary")
    bindings = '\n'.join(
        '    psenvaddition ' + name + ' "arn:aws:ssm:$AWS_REGION:$AWS_ACCOUNT_ID:parameter/config/common/global-appvar/' + name + '"'
        for name in ('ACCESS_CONTROL_BLOCKED_SUBJECTS', 'ACCESS_CONTROL_BLOCKED_USER_IDS')
    )
    return source.replace(marker, bindings + '\n' + marker)


if __name__ == "__main__":
    path = Path(sys.argv[1])
    path.write_text(bind_global_denylists(path.read_text()))
