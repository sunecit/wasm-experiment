FROM python:3.12.10-slim-bookworm
WORKDIR /workspace
ENV MPLCONFIGDIR=/tmp/matplotlib
COPY analysis/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY analysis /workspace/analysis
RUN python -m unittest discover -s analysis -p 'test_*.py'
ENTRYPOINT ["python", "analysis/analyze.py"]
