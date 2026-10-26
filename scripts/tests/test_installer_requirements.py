"""The verified wheelhouse, including Core, must select the installed versions."""
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPT = Path(__file__).resolve().parents[2] / 'docs/site/public/install.sh'

class InstallerRequirementsTests(unittest.TestCase):
    def test_server_and_cli_use_verified_component_versions(self):
        source = SCRIPT.read_text()
        code = re.search(r'"\$PYTHON" - "\$WHEELHOUSE"(?: "\$PRODUCT")? <<\x27PY\x27\n(.*?)\nPY', source, re.S).group(1)
        # Build a complete fixture for every configured release. No network/pip.
        releases = __import__('ast').literal_eval(re.search(r'releases = (\(.*?\n\))', code, re.S).group(1))
        for product in ('server', 'cli'):
            with self.subTest(product=product), tempfile.TemporaryDirectory() as directory:
                destination = Path(directory)
                payloads = {}; replaced=[]
                for index, (repo, tag, manifest_name, _) in enumerate(releases):
                    names = [('openagent-framework','7.2.0b9'),('openagent-cli','7.2.0b9')] if 'beta.69' in tag or 'beta.70' in tag else [('openagent-core','6.1.0b8')] if repo.endswith('openagent-core') else [('fixture-'+str(index),'1.0.0')]
                    rows=[];assets=[]
                    for name, version in names:
                        filename=name.replace('-','_')+'-'+version+'-py3-none-any.whl'
                        buf=io.BytesIO()
                        with zipfile.ZipFile(buf,'w') as archive:archive.writestr(name.replace('-','_')+'-'+version+'.dist-info/METADATA','Name: '+name+'\nVersion: '+version+'\n')
                        data=buf.getvalue();url='https://github.com/'+repo+'/releases/download/'+tag+'/'+filename
                        payloads[url]=data;rows.append({'file':filename,'sha256':__import__('hashlib').sha256(data).hexdigest()});assets.append({'name':filename,'browser_download_url':url})
                    manifest=json.dumps({'wheels':rows}).encode();digest=__import__('hashlib').sha256(manifest).hexdigest();replaced.append((repo,tag,manifest_name,digest))
                    url='https://github.com/'+repo+'/releases/download/'+tag+'/'+manifest_name;payloads[url]=manifest;assets.append({'name':manifest_name,'browser_download_url':url})
                    payloads['https://api.github.com/repos/'+repo+'/releases/tags/'+tag]=json.dumps({'assets':assets}).encode()
                fixture_code=re.sub(r'releases = \(.*?\n\)', 'releases = '+repr(tuple(replaced)), code, count=1, flags=re.S)
                def fetch(request, **kwargs):return io.BytesIO(payloads[request.full_url])
                with patch('sys.argv',['installer',str(destination),product]),patch('urllib.request.urlopen',fetch):
                    exec(compile(fixture_code,'installer-fixture','exec'),{'__name__':'__main__'})
                expected=['openagent-framework[discord,slack,whatsapp]==7.2.0b9','openagent-core[engine,providers,modules]==6.1.0b8'] if product=='server' else ['openagent-cli==7.2.0b9']
                self.assertEqual((destination/'install-requirements.txt').read_text().splitlines(),expected)
        self.assertNotRegex(source,r'DIST="openagent-(?:framework|cli).*==')
        self.assertIn('--requirement "$WHEELHOUSE/install-requirements.txt"',source)

if __name__ == '__main__':unittest.main()
