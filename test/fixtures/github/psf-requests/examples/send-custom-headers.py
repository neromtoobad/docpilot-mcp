"""Send a GET request with a custom User-Agent header."""
import requests


def main():
    headers = {'User-Agent': 'my-app/1.0'}
    response = requests.get('https://httpbin.org/headers', headers=headers)
    print(response.json())


if __name__ == '__main__':
    main()
