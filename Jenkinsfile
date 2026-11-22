// Lints and tests the bench, then builds the firmware-bench image and pushes it to registry:5000,
// tagged with the build number and latest. It pins nothing: the KubeCoder catalog's bench service,
// in KubeCoderDeploy's chart/values.yaml, names the image by latest, which each environment start
// resolves.
//
// Controller config:
//   - Job: FirmwareBench
//   - SCM: pvginkel/FirmwareBench, branch main
//   - Script Path: Jenkinsfile

library identifier: 'JenkinsPipelineUtils', changelog: false

pipeline {
    agent {
        kubernetes {
            inheritFrom 'jenkins-agent kaniko'
            yamlMergeStrategy merge()
            // node runs the image `cexec frontend` runs in a KubeCoder environment, under the
            // environment's uid, so a red gate here is one there too.
            yaml podYaml(images: [
                [image: 'registry:5000/kube-coder-frontend-toolchain:node-24', name: 'node', runAsUser: 1000],
            ])
        }
    }

    options {
        disableConcurrentBuilds(abortPrevious: true)
        skipDefaultCheckout()
        timeout(time: 60, unit: 'MINUTES')
        timestamps()
    }

    triggers {
        githubPush()
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        // The repo's lint is ESLint and tsc's typecheck in one script, the one `kc project lint`
        // runs, so the typecheck has no stage of its own.
        stage('Lint') {
            steps {
                container('node') {
                    sh 'npm ci'
                    sh 'npm run lint'
                }
            }
        }

        stage('Test') {
            steps {
                container('node') {
                    sh 'npm test'
                }
            }
        }

        stage('Build firmware-bench image') {
            steps {
                container('kaniko') {
                    script {
                        helmCharts.kaniko2(destinations: [
                            "registry:5000/firmware-bench:${currentBuild.number}",
                            'registry:5000/firmware-bench:latest',
                        ])
                    }
                }
            }
        }
    }
}
