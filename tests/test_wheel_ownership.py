from importlib.util import module_from_spec,spec_from_file_location
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

spec=spec_from_file_location('product_wheels',Path(__file__).resolve().parents[1]/'scripts/build_wheels.py')
builder=module_from_spec(spec);spec.loader.exec_module(builder)

class WheelOwnershipTests(unittest.TestCase):
    def test_split_distributions_cannot_silently_overwrite_shared_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            wheels=[]
            for distribution in ('openagent_cli','openagent_client_transport'):
                path=Path(directory)/(distribution+'.whl')
                with ZipFile(path,'w') as archive:
                    archive.writestr('openagent_client_transport/stream/protocol.py',distribution)
                    archive.writestr(distribution+'.dist-info/METADATA','Name: '+distribution)
                wheels.append(path)
            with self.assertRaisesRegex(ValueError,'shipped by both'):builder.verify_ownership(wheels)
