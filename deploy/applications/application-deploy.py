#!/usr/bin/python3
"""Generic local Compose recipe, invoked by Deployer (never needs sudo)."""
import json, os, pathlib, re, subprocess, sys, time, urllib.request

def run(*args, **kw):
    subprocess.run(args, check=True, **kw)

def inside(root, value):
    p = (root / value).resolve()
    if not p.is_relative_to(root.resolve()) or not p.is_file():
        raise ValueError('recipe path must be a file inside the repository')
    return p

def deploy(app, repo, recipe, sha):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', app) or not re.fullmatch(r'[a-f0-9]{7,40}', sha):
        raise ValueError('invalid application id or commit')
    root = pathlib.Path(repo).resolve()
    manifest = inside(root, recipe)
    if manifest.stat().st_size > 65536:
        raise ValueError('recipe too large')
    config = json.loads(manifest.read_text())
    compose = inside(root, config['compose'])
    env = dict(os.environ, APP_IMAGE=f'application-{app}:{sha}', DEPLOY_COMMIT=sha)
    source = config.get('source')
    if source:
        url, commit = source['repository'], source['commit']
        if not re.fullmatch(r'https://github.com/[\w.-]+/[\w.-]+(?:\.git)?', url) or not re.fullmatch(r'[a-f0-9]{40}', commit):
            raise ValueError('source requires a GitHub repository and full pinned commit')
        cache = pathlib.Path('/var/lib/applications') / app / 'source'
        cache.parent.mkdir(parents=True, exist_ok=True)
        if not (cache / '.git').exists():
            run('git', 'clone', '--no-checkout', url, str(cache))
        run('git', '-C', str(cache), 'fetch', '--depth', '1', url, commit)
        run('git', '-C', str(cache), 'checkout', '--detach', commit)
        dockerfile = inside(root, config['dockerfile'])
        if subprocess.run(['docker', 'image', 'inspect', env['APP_IMAGE']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            run('docker', 'build', '-f', str(dockerfile), '-t', env['APP_IMAGE'], str(cache), env=env)
    command = ['docker-compose', '-p', 'application-' + app, '-f', str(compose)]
    run(*command, 'config', '--quiet', env=env)
    run(*command, 'up', '-d', '--build', '--remove-orphans', env=env)
    url = config['healthUrl']
    if not re.fullmatch(r'http://(?:127\.0\.0\.1|192\.168\.1\.236):\d{2,5}/[^\s]*', url):
        raise ValueError('healthUrl must target local Applications HTTP')
    last = ''
    for _ in range(40):
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                body = response.read(500000).decode('utf-8', 'replace')
                if response.status == 200 and config.get('expect', '') in body:
                    print('Application started and health verified:', app)
                    return
        except Exception as error:
            last = type(error).__name__
        time.sleep(2)
    raise RuntimeError('application health check failed: ' + last)

if __name__ == '__main__':
    try:
        deploy(*sys.argv[1:])
    except Exception as error:
        print('Deployment failed:', str(error), file=sys.stderr)
        sys.exit(1)
