"""POST a JSON body to a public echo endpoint."""
import requests
import json


def main():
    payload = {'hello': 'world'}
    response = requests.post('https://httpbin.org/post', json=payload)
    print(json.dumps(response.json(), indent=2))


if __name__ == '__main__':
    main()
