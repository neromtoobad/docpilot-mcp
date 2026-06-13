# Requests

A simple, yet elegant, HTTP library for Python.

## Quickstart

```python
import requests

response = requests.get('https://api.github.com')
print(response.status_code)
```

## POST a JSON body

```python
import requests
import json

response = requests.post('https://httpbin.org/post', json={'hello': 'world'})
print(response.json())
```

## Send custom headers

```python
import requests

headers = {'User-Agent': 'my-app/1.0'}
response = requests.get('https://httpbin.org/headers', headers=headers)
print(response.json())
```
