"""Exercise the secret binding hook with the pinned suite's function contract."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location("binding", Path(__file__).with_name("bind-global-denylists.py"))
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)


class BindGlobalDenylistsTest(unittest.TestCase):
    def test_global_names_override_local_but_audience_keeps_local_binding(self):
        source = """psenvaddition() {
    envname=$1
    envvalue=$2
    printf '%s\\n' "$envvalue"
}
"""
        # The generated bindings belong inside the deployment function.
        source += 'deploy() {\n    log "Environment has updated"\n}\n'
        patched = binding.bind_global_denylists(source)
        self.assertEqual(patched.count('    psenvaddition ACCESS_CONTROL_BLOCKED_'), 2)
        script = patched + """
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=123456789012
psenvaddition ACCESS_CONTROL_BLOCKED_SUBJECTS /config/tc-ai-api/appvar/ACCESS_CONTROL_BLOCKED_SUBJECTS
psenvaddition ACCESS_CONTROL_BLOCKED_USER_IDS /local
psenvaddition AUTH0_AUDIENCE /config/tc-ai-api/appvar/AUTH0_AUDIENCE
"""
        actual = subprocess.check_output(['bash', '-c', script], text=True).splitlines()
        prefix = 'arn:aws:ssm:us-east-1:123456789012:parameter/config/common/global-appvar/'
        self.assertEqual(actual, [prefix + 'ACCESS_CONTROL_BLOCKED_SUBJECTS', prefix + 'ACCESS_CONTROL_BLOCKED_USER_IDS', '/config/tc-ai-api/appvar/AUTH0_AUDIENCE'])

    def test_unexpected_suite_fails(self):
        with self.assertRaises(ValueError):
            binding.bind_global_denylists('psenvaddition() {\n    changed_contract=true\n}\n')


if __name__ == '__main__':
    unittest.main()
