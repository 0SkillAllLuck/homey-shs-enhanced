{{- define "homey-shs-enhanced.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "homey-shs-enhanced.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{- define "homey-shs-enhanced.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "homey-shs-enhanced.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "homey-shs-enhanced.selectorLabels" -}}
app.kubernetes.io/name: {{ include "homey-shs-enhanced.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "homey-shs-enhanced.image" -}}
{{- $repo := required "image.repository is required — build the image from this repo and push it to a registry you control (the project never distributes images; see the licensing note in its README)" .Values.image.repository -}}
{{- printf "%s:%s" $repo (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end }}

{{- define "homey-shs-enhanced.claimName" -}}
{{- .Values.persistence.existingClaim | default (include "homey-shs-enhanced.fullname" .) -}}
{{- end }}
