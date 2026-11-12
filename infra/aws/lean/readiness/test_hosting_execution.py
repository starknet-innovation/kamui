import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE/(name+'.py'))
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


skeleton=load('prepare_private_input')
launch=load('launch_host')


class HostingExecutionTest(unittest.TestCase):
    def test_private_skeleton_is_exclusive_and_does_not_choose_resources(self):
        with tempfile.TemporaryDirectory() as path:
            path=Path(path).resolve()
            skeleton.prepare(str(path))
            output=path/'aws-input.json'
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            data=json.loads(output.read_text())
            self.assertEqual(data['backend']['aws_profile'], 'kamui-backend-test')
            self.assertEqual(data['pepper']['aws_profile'], 'kamui-pepper-test')
            self.assertEqual(data['backend']['expected_account'], '')
            self.assertEqual(data['pepper']['pepper_key_id'], '')
            with self.assertRaises(FileExistsError):skeleton.prepare(str(path))

    def test_world_accessible_skeleton_destination_refused(self):
        with tempfile.TemporaryDirectory() as path:
            path=Path(path).resolve();path.chmod(0o755)
            with self.assertRaises(ValueError):skeleton.prepare(str(path))
            self.assertFalse((path/'aws-input.json').exists())

    def test_failed_inventory_never_builds_a_launch(self):
        with patch.object(launch.inspect_aws, 'inspect', return_value={'all_observed_checks_passed': False}), patch.object(launch.provision, 'validate') as validate:
            with self.assertRaisesRegex(ValueError, 'AWS_INPUT_OBSERVATIONS_NOT_PASSED'):
                launch.prepare({}, 'backend', '/unused', None)
            validate.assert_not_called()

    def test_rechecked_ami_must_match_reviewed_id_and_publisher(self):
        class Client:
            def request(self, *args):return {'Images': [{'ImageId': 'changed', 'OwnerId': 'publisher'}]}
        with patch.object(launch.inspect_aws, 'inspect', return_value={'all_observed_checks_passed': True}):
            with self.assertRaisesRegex(ValueError, 'REVIEWED_IMAGE_CHANGED'):
                launch.prepare({'backend': {'aws_profile':'fixture','ami_id':'reviewed','approved_ami_owner':'publisher'}}, 'backend', '/unused', Client())


if __name__ == '__main__':unittest.main()
