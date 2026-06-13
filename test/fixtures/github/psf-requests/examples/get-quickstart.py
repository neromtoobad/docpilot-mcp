"""Send a GET request to the GitHub API and print the status code."""
import requests


def main():
    response = requests.get('https://api.github.com')
    print(response.status_code)


if __name__ == '__main__':
    main()
